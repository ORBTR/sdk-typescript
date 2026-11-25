// The hand-written layer: configuration, retries and Retry-After, timeouts, error bodies, the event-stream
// decoder and the flow helpers.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APIConnectionError,
  APITimeoutError,
  BadRequestError,
  InternalServerError,
  MAX_RETRY_AFTER_MS,
  Orbtr,
  OrbtrError,
  PaymentRequiredError,
  RateLimitError,
  SSEDecoder,
  StreamError,
  flowModel,
  isFlowModel,
  parseFlowModel,
} from "../src/index.js";
import { backoffMs, isRetryableStatus, parseRetryAfter } from "../src/core.js";
import { describeErrorBody } from "../src/errors.js";

type Reply = { status: number; headers?: Record<string, string>; body?: string } | Error;

function scripted(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const r = replies.shift();
    if (!r) throw new Error("no reply scripted");
    if (r instanceof Error) throw r;
    return new Response(r.body ?? "{}", { status: r.status, headers: r.headers });
  };
  return { fetch: f as typeof fetch, calls };
}

const ok = { status: 200, body: '{"object":"list","data":[]}' };

test("the key is read from ORBTR_API_KEY and sent as a bearer token", async () => {
  const before = process.env.ORBTR_API_KEY;
  process.env.ORBTR_API_KEY = "env-key";
  try {
    const { fetch, calls } = scripted(ok);
    await new Orbtr({ fetch }).models.list();
    const h = new Headers(calls[0]!.init.headers);
    assert.equal(h.get("authorization"), "Bearer env-key");
    assert.equal(calls[0]!.url, "https://api.orbtr.ai/v1/models");
  } finally {
    if (before === undefined) delete process.env.ORBTR_API_KEY;
    else process.env.ORBTR_API_KEY = before;
  }
});

test("a client with no key is refused at construction", () => {
  const before = process.env.ORBTR_API_KEY;
  delete process.env.ORBTR_API_KEY;
  try {
    assert.throws(() => new Orbtr({ fetch: scripted().fetch }), OrbtrError);
  } finally {
    if (before !== undefined) process.env.ORBTR_API_KEY = before;
  }
});

test("the base URL comes from the option, then ORBTR_BASE_URL, without a trailing slash", async () => {
  const { fetch, calls } = scripted(ok, ok);
  await new Orbtr({ apiKey: "k", baseURL: "http://127.0.0.1:9/", fetch }).models.list();
  assert.equal(calls[0]!.url, "http://127.0.0.1:9/v1/models");
  const before = process.env.ORBTR_BASE_URL;
  process.env.ORBTR_BASE_URL = "http://127.0.0.2:9";
  try {
    await new Orbtr({ apiKey: "k", fetch }).models.list();
    assert.equal(calls[1]!.url, "http://127.0.0.2:9/v1/models");
  } finally {
    if (before === undefined) delete process.env.ORBTR_BASE_URL;
    else process.env.ORBTR_BASE_URL = before;
  }
});

test("a caller's header cannot replace the Authorization header", async () => {
  const { fetch, calls } = scripted(ok);
  await new Orbtr({ apiKey: "k", fetch, defaultHeaders: { Authorization: "Bearer other" } }).models.list({
    headers: { "X-Trace": "1" },
  });
  const h = new Headers(calls[0]!.init.headers);
  assert.equal(h.get("authorization"), "Bearer k");
  assert.equal(h.get("x-trace"), "1");
});

test("a 429 with Retry-After waits that long, then succeeds", async () => {
  const { fetch, calls } = scripted({ status: 429, headers: { "Retry-After": "1" }, body: '{"error":"api_key_rate_limit_exceeded"}' }, ok);
  const started = Date.now();
  await new Orbtr({ apiKey: "k", fetch }).models.list();
  const waited = Date.now() - started;
  assert.equal(calls.length, 2);
  assert.ok(waited >= 950, `waited ${waited} ms`);
});

test("a Retry-After above the longest wait is raised instead of retried", async () => {
  const { fetch, calls } = scripted({ status: 503, headers: { "Retry-After": "3600" }, body: '{"type":"error","error":{"type":"no_servable_placement","message":"nothing can serve the model now"}}' });
  await assert.rejects(new Orbtr({ apiKey: "k", fetch }).models.list(), (err: unknown) => {
    assert.ok(err instanceof InternalServerError);
    assert.equal(err.code, "no_servable_placement");
    assert.equal(err.headers.get("retry-after"), "3600");
    return true;
  });
  assert.equal(calls.length, 1);
});

test("5xx responses are retried up to maxRetries", async () => {
  const fail = { status: 529, headers: { "Retry-After": "0" }, body: '{"type":"error","error":{"type":"fleet_overload","message":"busy"}}' };
  const { fetch, calls } = scripted(fail, fail, fail);
  await assert.rejects(new Orbtr({ apiKey: "k", fetch, maxRetries: 2 }).models.list(), InternalServerError);
  assert.equal(calls.length, 3);
});

test("a call's maxRetries overrides the client's", async () => {
  const fail = { status: 500, headers: { "Retry-After": "0" }, body: "{}" };
  const { fetch, calls } = scripted(fail, ok);
  await assert.rejects(new Orbtr({ apiKey: "k", fetch, maxRetries: 5 }).models.list({ maxRetries: 0 }), InternalServerError);
  assert.equal(calls.length, 1);
});

test("4xx responses other than 429 are not retried", async () => {
  for (const [status, cls] of [
    [400, BadRequestError],
    [402, PaymentRequiredError],
  ] as const) {
    const { fetch, calls } = scripted({ status, body: '{"type":"error","error":{"type":"x","message":"no"}}' });
    await assert.rejects(new Orbtr({ apiKey: "k", fetch }).models.list(), cls);
    assert.equal(calls.length, 1);
  }
});

test("a connection failure is retried, then raised as APIConnectionError", async () => {
  const { fetch, calls } = scripted(new TypeError("fetch failed"), new TypeError("fetch failed"));
  await assert.rejects(new Orbtr({ apiKey: "k", fetch, maxRetries: 1 }).models.list(), (err: unknown) => {
    assert.ok(err instanceof APIConnectionError);
    assert.ok(!(err instanceof APITimeoutError));
    return true;
  });
  assert.equal(calls.length, 2);
});

test("a call longer than its timeout raises APITimeoutError", async () => {
  const hang = (async (_: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as typeof fetch;
  await assert.rejects(new Orbtr({ apiKey: "k", fetch: hang, timeout: 50, maxRetries: 0 }).models.list(), APITimeoutError);
});

test("every retry of a batch create sends the same Idempotency-Key", async () => {
  const fail = { status: 503, headers: { "Retry-After": "0" }, body: "{}" };
  const { fetch, calls } = scripted(fail, { status: 200, body: "{}" });
  await new Orbtr({ apiKey: "k", fetch }).messages.batches.create({ requests: [] });
  const keys = calls.map((c) => new Headers(c.init.headers).get("idempotency-key"));
  assert.equal(keys.length, 2);
  assert.ok(keys[0]);
  assert.equal(keys[0], keys[1]);
});

test("no other call sends an Idempotency-Key, since api.orbtr.ai refuses one there", async () => {
  const { fetch, calls } = scripted({ status: 200, body: '{"input_tokens":1}' });
  await new Orbtr({ apiKey: "k", fetch }).messages.countTokens({ model: "m", messages: [] });
  assert.equal(new Headers(calls[0]!.init.headers).get("idempotency-key"), null);
});

test("Retry-After reads seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter("0.5"), 500);
  const now = Date.parse("Wed, 25 Nov 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("Wed, 25 Nov 2026 10:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("Wed, 25 Nov 2026 09:00:00 GMT", now), 0);
  assert.equal(parseRetryAfter("soon"), undefined);
  assert.equal(MAX_RETRY_AFTER_MS, 60_000);
});

test("backoff doubles from 0.5 s to at most 8 s, with jitter taking off up to a quarter", () => {
  assert.equal(backoffMs(0, () => 0), 500);
  assert.equal(backoffMs(1, () => 0), 1000);
  assert.equal(backoffMs(10, () => 0), 8000);
  assert.equal(backoffMs(0, () => 1), 375);
  assert.ok(isRetryableStatus(429) && isRetryableStatus(500) && isRetryableStatus(529));
  assert.ok(!isRetryableStatus(400) && !isRetryableStatus(404) && !isRetryableStatus(409));
});

test("error bodies of every shape give their code, message and reason", () => {
  assert.deepEqual(describeErrorBody({ type: "error", error: { type: "insufficient_ot", message: "short" } }), {
    code: "insufficient_ot",
    message: "short",
    reason: undefined,
  });
  assert.deepEqual(describeErrorBody({ error: { message: "m", type: "authentication_error", code: null, param: null } }), {
    code: "authentication_error",
    message: "m",
    reason: undefined,
  });
  assert.deepEqual(describeErrorBody({ error: "key_expired_or_revoked", reason: "rotated" }), {
    code: "key_expired_or_revoked",
    message: undefined,
    reason: "rotated",
  });
  assert.deepEqual(
    describeErrorBody({ type: "error", error: "assistant_mismatch", stored: "a", requested: "b", message: "pinned" }),
    { code: "assistant_mismatch", message: "pinned", reason: undefined },
  );
  assert.deepEqual(describeErrorBody("text"), {});
});

test("a revoked key's reason reaches the error", async () => {
  const { fetch } = scripted({ status: 401, body: '{"error":"key_expired_or_revoked","reason":"revoked"}' });
  await assert.rejects(new Orbtr({ apiKey: "k", fetch }).models.list(), (err: unknown) => {
    assert.ok(err instanceof OrbtrError && "reason" in err);
    assert.equal((err as { reason?: string }).reason, "revoked");
    return true;
  });
});

test("a rate-limit body from the key gateway raises RateLimitError", async () => {
  const fail = { status: 429, headers: { "Retry-After": "0" }, body: '{"error":"api_key_rate_limit_exceeded"}' };
  const { fetch } = scripted(fail, fail, fail);
  await assert.rejects(new Orbtr({ apiKey: "k", fetch }).models.list(), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.code, "api_key_rate_limit_exceeded");
    return true;
  });
});

function decodeAll(text: string, size: number) {
  const d = new SSEDecoder();
  const bytes = new TextEncoder().encode(text);
  const out = [];
  for (let i = 0; i < bytes.length; i += size) out.push(...d.push(bytes.slice(i, i + size)));
  out.push(...d.end());
  return out;
}

test("the event-stream decoder handles every line ending, comments and split chunks", () => {
  const text = ": comment\r\nevent: a\r\ndata: 1\r\ndata: 2\r\n\r\nevent: b\rdata:x\r\rdata: tail";
  for (const size of [1, 2, 3, 5, 100]) {
    const evs = decodeAll(text, size);
    assert.deepEqual(
      evs.map((e) => [e.event, e.data]),
      [
        ["a", "1\n2"],
        ["b", "x"],
        [undefined, "tail"],
      ],
      `chunk size ${size}`,
    );
  }
});

test("the event-stream decoder keeps multi-byte characters split across chunks", () => {
  const evs = decodeAll("data: café ☕\n\n", 1);
  assert.equal(evs[0]?.data, "café ☕");
});

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("an error event in a Messages stream raises StreamError", async () => {
  const body =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
    'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"inference stream failed"}}\n\n';
  const f = (async () => sse(body)) as typeof fetch;
  const stream = await new Orbtr({ apiKey: "k", fetch: f }).messages.stream({ model: "x", messages: [] });
  const seen: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const ev of stream) seen.push(ev.type);
    })(),
    (err: unknown) => err instanceof StreamError && err.code === "api_error",
  );
  assert.deepEqual(seen, ["message_start"]);
});

test("ORBTR's progress events pass through a Messages stream with their data", async () => {
  const body =
    'event: orbtr.ai.turn.started\ndata: {"turn":"t1"}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const f = (async () => sse(body)) as typeof fetch;
  const stream = await new Orbtr({ apiKey: "k", fetch: f }).messages.stream({ model: "x", messages: [] });
  const seen = [];
  for await (const ev of stream) seen.push(ev);
  assert.deepEqual(seen, [{ type: "orbtr.ai.turn.started", data: { turn: "t1" } }, { type: "message_stop" }]);
});

test("a tool call's input is gathered from its JSON pieces", async () => {
  const body = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"lookup","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\": \\"Sy"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"dney\\"}"}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":5}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join("\n\n") + "\n\n";
  const f = (async () => sse(body)) as typeof fetch;
  const stream = await new Orbtr({ apiKey: "k", fetch: f }).messages.stream({ model: "x", messages: [] });
  const m = await stream.finalMessage();
  assert.deepEqual(m.content[0]?.input, { city: "Sydney" });
  assert.equal(m.stop_reason, "tool_use");
  assert.equal(m.usage.output_tokens, 5);
  assert.equal(m.usage.input_tokens, 1);
});

test("flow models are built and read", () => {
  assert.equal(flowModel("partition:p1:flow:council"), "partition:p1:flow:council");
  assert.equal(flowModel("partition:p1:flow:council", 3), "partition:p1:flow:council@3");
  assert.throws(() => flowModel("orbtr-model-1"), TypeError);
  assert.throws(() => flowModel("partition:p1:flow:council@2", 3), TypeError);
  assert.throws(() => flowModel("partition:p1:flow:council", 0), RangeError);
  assert.throws(() => flowModel("partition:p1:flow:council", 1.5), RangeError);
  assert.ok(isFlowModel("partition:p1:flow:council@2"));
  assert.ok(!isFlowModel("orbtr-model-1"));
  assert.deepEqual(parseFlowModel("partition:p1:flow:council@2"), { flowId: "partition:p1:flow:council", version: 2 });
  assert.deepEqual(parseFlowModel("partition:p1:flow:council"), { flowId: "partition:p1:flow:council" });
  assert.equal(parseFlowModel("orbtr-model-1"), undefined);
});
