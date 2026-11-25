// Each call against the exchange recorded from api.orbtr.ai's handler: the SDK sends the recorded request
// (method, path, query, body) with the API key as a bearer token, and reads the recorded response.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AuthenticationError,
  NotFoundError,
  Orbtr,
  RateLimitError,
  flowModel,
  type ContentBlockDeltaEvent,
  type MessageStreamEvent,
} from "../src/index.js";
import { fixture, fixtureFetch, fixtureNames, type SentRequest } from "./helpers.js";

function client(f: typeof fetch, maxRetries = 0): Orbtr {
  return new Orbtr({ apiKey: "test-key", baseURL: "https://api.orbtr.test", fetch: f, maxRetries });
}

function assertSent(sent: SentRequest, name: string): void {
  const fx = fixture(name);
  assert.equal(sent.method, fx.request.method, `${name}: method`);
  assert.equal(sent.url.pathname, fx.request.path, `${name}: path`);
  assert.equal(sent.url.search.replace(/^\?/, ""), fx.request.query ?? "", `${name}: query`);
  assert.deepEqual(sent.body, fx.request.body, `${name}: body`);
  assert.equal(sent.headers.get("authorization"), "Bearer test-key");
  assert.equal(sent.headers.get("x-api-key"), null);
  assert.match(sent.headers.get("user-agent") ?? "", /^orbtr-sdk-typescript\//);
  if (fx.request.body !== undefined) assert.equal(sent.headers.get("content-type"), "application/json");
}

test("every recorded fixture is used by a test", () => {
  const used = new Set([
    "messages-create",
    "messages-stream",
    "messages-stream-rendered",
    "messages-count-tokens",
    "messages-create-flow",
    "messages-stream-flow",
    "chat-completions-create",
    "chat-completions-stream",
    "chat-completions-create-flow",
    "completions-create",
    "embeddings-create",
    "models-list",
    "batches-create",
    "batches-list",
    "batches-retrieve",
    "batches-cancel",
    "batches-results",
    "error-flow-not-found",
    "error-messages-no-key",
    "error-chat-no-key",
    "error-missing-bearer-token",
    "error-rate-limited",
  ]);
  assert.deepEqual(fixtureNames().sort(), [...used].sort());
});

const seaMessage = {
  model: "orbtr-model-1",
  max_tokens: 256,
  messages: [{ role: "user" as const, content: "Write one sentence about the sea." }],
};

test("messages.create", async () => {
  const { fetch, sent } = fixtureFetch("messages-create");
  const msg = await client(fetch).messages.create(seaMessage);
  assertSent(sent[0]!, "messages-create");
  assert.equal(sent[0]!.headers.get("idempotency-key"), null);
  assert.equal(msg.id, "msg_sdk_01");
  assert.equal(msg.content[0]?.type, "text");
  assert.equal(msg.content[0]?.text, "The sea is wide and grey.");
  assert.equal(msg.stop_reason, "end_turn");
  assert.equal(msg.usage.input_tokens, 14);
  assert.equal(msg.usage.output_tokens, 9);
  assert.equal(msg.usage.ot_consumed, 12);
});

test("messages.create drops a stream flag a JavaScript caller passes", async () => {
  const { fetch, sent } = fixtureFetch("messages-create");
  await client(fetch).messages.create({ ...seaMessage, stream: true } as typeof seaMessage);
  assertSent(sent[0]!, "messages-create");
});

test("messages.stream through the native stream", async () => {
  const { fetch, sent } = fixtureFetch("messages-stream");
  const stream = await client(fetch).messages.stream(seaMessage);
  assertSent(sent[0]!, "messages-stream");
  assert.equal(sent[0]!.headers.get("accept"), "text/event-stream");
  const types: string[] = [];
  let text = "";
  for await (const ev of stream) {
    types.push(ev.type);
    if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") text += ev.delta.text;
  }
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "ping",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(text, "The sea is wide and grey.");
  const final = await stream.finalMessage();
  assert.equal(final.content[0]?.text, "The sea is wide and grey.");
  assert.equal(final.stop_reason, "end_turn");
  assert.equal(final.usage.output_tokens, 9);
});

test("messages.stream rendered after a unary dispatch gathers the same reply", async () => {
  const { fetch, sent } = fixtureFetch("messages-stream-rendered");
  const stream = await client(fetch).messages.stream(seaMessage);
  assertSent(sent[0]!, "messages-stream-rendered");
  assert.equal(await stream.finalText(), "The sea is wide and grey.");
});

test("messages.countTokens", async () => {
  const { fetch, sent } = fixtureFetch("messages-count-tokens");
  const n = await client(fetch).messages.countTokens({
    model: "orbtr-model-1",
    messages: [{ role: "user", content: "How long is this request?" }],
  });
  assertSent(sent[0]!, "messages-count-tokens");
  assert.equal(n.input_tokens, 14);
});

test("a flow called as a model, pinned to a version", async () => {
  const { fetch, sent } = fixtureFetch("messages-create-flow");
  const msg = await client(fetch).messages.create({
    model: flowModel("partition:p1:flow:council", 2),
    max_tokens: 64,
    messages: [{ role: "user", content: "review this" }],
  });
  assertSent(sent[0]!, "messages-create-flow");
  assert.equal(msg.content[0]?.text, "the council agrees");
  const run = msg.usage.orbtr;
  assert.ok(run);
  assert.equal(run.kind, "flow");
  assert.equal(run.flowId, "partition:p1:flow:council");
  assert.equal(run.version, 2);
  assert.equal(run.totalOt, 7);
  assert.equal(
    run.steps.reduce((n, s) => n + s.ot, 0),
    run.totalOt,
  );
});

test("a streamed flow carries the run's usage on message_delta", async () => {
  const { fetch, sent } = fixtureFetch("messages-stream-flow");
  const stream = await client(fetch).messages.stream({
    model: flowModel("partition:p1:flow:council"),
    max_tokens: 64,
    messages: [{ role: "user", content: "review this" }],
  });
  assertSent(sent[0]!, "messages-stream-flow");
  const final = await stream.finalMessage();
  assert.equal(final.content[0]?.text, "the council agrees");
  assert.equal(final.usage.orbtr?.runId, "run1");
});

test("chat.completions.create", async () => {
  const { fetch, sent } = fixtureFetch("chat-completions-create");
  const reply = await client(fetch).chat.completions.create({
    model: "orbtr-model-1",
    messages: [{ role: "user", content: "Write one sentence about the sea." }],
  });
  assertSent(sent[0]!, "chat-completions-create");
  assert.equal(reply.object, "chat.completion");
  assert.equal(reply.choices[0]?.message.content, "The sea is wide and grey.");
  assert.equal(reply.usage.total_tokens, 23);
});

test("chat.completions.stream ends at [DONE]", async () => {
  const { fetch, sent } = fixtureFetch("chat-completions-stream");
  const stream = await client(fetch).chat.completions.stream({
    model: "orbtr-model-1",
    messages: [{ role: "user", content: "Write one sentence about the sea." }],
  });
  assertSent(sent[0]!, "chat-completions-stream");
  let text = "";
  let finish: string | null | undefined;
  for await (const chunk of stream) {
    text += chunk.choices[0]?.delta.content ?? "";
    finish = chunk.choices[0]?.finish_reason ?? finish;
  }
  assert.equal(text, "The sea is wide and grey.");
  assert.equal(finish, "stop");
});

test("a flow on the OpenAI-compatible route", async () => {
  const { fetch, sent } = fixtureFetch("chat-completions-create-flow");
  const reply = await client(fetch).chat.completions.create({
    model: "partition:p1:flow:council",
    messages: [{ role: "user", content: "review this" }],
  });
  assertSent(sent[0]!, "chat-completions-create-flow");
  assert.equal(reply.choices[0]?.message.content, "the council agrees");
  assert.equal(reply.usage.orbtr?.version, 2);
});

test("completions.create", async () => {
  const { fetch, sent } = fixtureFetch("completions-create");
  const reply = await client(fetch).completions.create({ model: "orbtr-model-1", prompt: "The sea is", max_tokens: 32 });
  assertSent(sent[0]!, "completions-create");
  assert.equal(reply.object, "text_completion");
  assert.equal(reply.choices[0]?.text, "The sea is wide and grey.");
});

test("embeddings.create", async () => {
  const { fetch, sent } = fixtureFetch("embeddings-create");
  const out = await client(fetch).embeddings.create({ model: "orbtr-embed-1", input: ["the sea", "the sky"] });
  assertSent(sent[0]!, "embeddings-create");
  assert.equal(out.data.length, 2);
  assert.deepEqual(out.data[0]?.embedding, [0.25, -0.5, 0.125]);
  assert.equal(out.usage.prompt_tokens, 6);
});

test("models.list", async () => {
  const { fetch, sent } = fixtureFetch("models-list");
  const models = await client(fetch).models.list();
  assertSent(sent[0]!, "models-list");
  assert.deepEqual(
    models.data.map((m) => m.id),
    ["orbtr-embed-1", "orbtr-model-1", "orbtr-model-2"],
  );
  assert.equal(models.data[1]?.context_length, 131072);
  assert.equal(models.data[0]?.context_length, undefined);
});

const batchParams = {
  requests: [
    {
      custom_id: "first",
      params: { model: "orbtr-model-1", max_tokens: 64, messages: [{ role: "user" as const, content: "Say hello." }] },
    },
    {
      custom_id: "second",
      params: { model: "orbtr-model-2", max_tokens: 64, messages: [{ role: "user" as const, content: "Say hello." }] },
    },
  ],
};

test("messages.batches.create sends an Idempotency-Key", async () => {
  const { fetch, sent } = fixtureFetch("batches-create");
  const batch = await client(fetch).messages.batches.create(batchParams);
  assertSent(sent[0]!, "batches-create");
  assert.match(sent[0]!.headers.get("idempotency-key") ?? "", /^orbtr-sdk-/);
  assert.equal(batch.processing_status, "in_progress");
  assert.equal(batch.request_counts.processing, 2);
});

test("messages.batches.create sends the caller's Idempotency-Key", async () => {
  const { fetch, sent } = fixtureFetch("batches-create");
  await client(fetch).messages.batches.create(batchParams, { idempotencyKey: "nightly-2026-11-25" });
  assert.equal(sent[0]!.headers.get("idempotency-key"), "nightly-2026-11-25");
});

test("messages.batches.list, retrieve, cancel and results", async () => {
  const { fetch, sent } = fixtureFetch("batches-list", "batches-retrieve", "batches-cancel", "batches-results");
  const c = client(fetch);
  const page = await c.messages.batches.list({ limit: 20 });
  assertSent(sent[0]!, "batches-list");
  assert.equal(page.has_more, false);
  assert.equal(page.last_id, "msgbatch_sdk_01");
  const one = await c.messages.batches.retrieve("msgbatch_sdk_01");
  assertSent(sent[1]!, "batches-retrieve");
  assert.equal(one.processing_status, "ended");
  const canceled = await c.messages.batches.cancel("msgbatch_sdk_01");
  assertSent(sent[2]!, "batches-cancel");
  assert.equal(canceled.processing_status, "canceling");
  const results = await c.messages.batches.results("msgbatch_sdk_01");
  assertSent(sent[3]!, "batches-results");
  assert.equal(sent[3]!.headers.get("accept"), "application/x-ndjson");
  assert.deepEqual(
    results.map((r) => [r.custom_id, r.result.type]),
    [
      ["first", "succeeded"],
      ["second", "errored"],
    ],
  );
  assert.equal(results[0]?.result.message?.content[0]?.text, "Hello.");
  assert.equal(results[1]?.result.error?.type, "model_not_entitled");
});

test("an unknown flow raises NotFoundError", async () => {
  const { fetch } = fixtureFetch("error-flow-not-found");
  await assert.rejects(
    client(fetch).messages.create({
      model: "partition:p1:flow:unknown",
      max_tokens: 64,
      messages: [{ role: "user", content: "review this" }],
    }),
    (err: unknown) => err instanceof NotFoundError && err.status === 404 && err.code === "not_found_error",
  );
});

test("the three refusal shapes raise AuthenticationError with their code", async () => {
  for (const [name, code] of [
    ["error-messages-no-key", "authentication_error"],
    ["error-chat-no-key", "authentication_error"],
    ["error-missing-bearer-token", "missing_bearer_token"],
  ] as const) {
    const { fetch } = fixtureFetch(name);
    await assert.rejects(client(fetch).models.list(), (err: unknown) => {
      assert.ok(err instanceof AuthenticationError, name);
      assert.equal(err.status, 401);
      assert.equal(err.code, code, name);
      return true;
    });
  }
});

test("a 429 is retried, then raised as RateLimitError with its code", async () => {
  const { fetch, sent } = fixtureFetch("error-rate-limited", "error-rate-limited");
  await assert.rejects(client(fetch, 1).messages.create(seaMessage), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.code, "partition_inflight_exceeded");
    assert.equal(err.headers.get("x-admission-reject-reason"), "partition_inflight_exceeded");
    return true;
  });
  assert.equal(sent.length, 2);
});

test("stream events narrow by type", () => {
  const ev: MessageStreamEvent = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } };
  if (ev.type === "content_block_delta") {
    const d: ContentBlockDeltaEvent = ev;
    assert.equal(d.delta.text, "x");
  }
});
