// The built package over real HTTP against a local fake of the /v1 surface (fake-server.ts): every call,
// streaming, flows as models, retries after 429 and 503, typed errors, and each example in examples/.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import {
  AuthenticationError,
  NotFoundError,
  Orbtr,
  StreamError,
  flowModel,
} from "../src/index.js";
import { FAKE_KEY, startFake, type Fake } from "./fake-server.js";
import { repoRoot } from "./helpers.js";

const run = promisify(execFile);
let fake: Fake;

before(async () => {
  fake = await startFake();
});

after(async () => {
  await fake.close();
});

test("a whole session against the fake /v1 surface", async () => {
  const client = new Orbtr({ apiKey: FAKE_KEY, baseURL: fake.url });
  const user = (content: string) => [{ role: "user" as const, content }];

  const models = await client.models.list();
  assert.ok(models.data.some((m) => m.id === "orbtr-model-1"));

  const msg = await client.messages.create({ model: "orbtr-model-1", max_tokens: 256, messages: user("Write one sentence about the sea.") });
  assert.equal(msg.content[0]?.text, "The sea is wide and grey.");

  const stream = await client.messages.stream({ model: "orbtr-model-1", max_tokens: 256, messages: user("Write one sentence about the sea.") });
  assert.equal(await stream.finalText(), "The sea is wide and grey.");

  assert.equal((await client.messages.countTokens({ model: "orbtr-model-1", messages: user("How long?") })).input_tokens, 14);

  const flow = await client.messages.create({ model: flowModel("partition:p1:flow:council", 2), max_tokens: 64, messages: user("review this") });
  assert.equal(flow.usage.orbtr?.version, 2);
  await assert.rejects(
    client.messages.create({ model: flowModel("partition:p1:flow:missing"), max_tokens: 64, messages: user("x") }),
    NotFoundError,
  );

  const emb = await client.embeddings.create({ model: "orbtr-embed-1", input: ["the sea", "the sky"] });
  assert.equal(emb.data.length, 2);

  const chat = await client.chat.completions.create({ model: "orbtr-model-1", messages: user("hi") });
  assert.equal(chat.choices[0]?.message.content, "The sea is wide and grey.");
  let streamed = "";
  for await (const chunk of await client.chat.completions.stream({ model: "orbtr-model-1", messages: user("hi") })) {
    streamed += chunk.choices[0]?.delta.content ?? "";
  }
  assert.equal(streamed, "The sea is wide and grey.");
  const legacy = await client.completions.create({ model: "orbtr-model-1", prompt: "The sea is" });
  assert.equal(legacy.choices[0]?.text, "The sea is wide and grey.");

  const batch = await client.messages.batches.create({
    requests: [{ custom_id: "first", params: { model: "orbtr-model-1", max_tokens: 64, messages: user("Say hello.") } }],
  });
  assert.equal(batch.id, "msgbatch_sdk_01");
  assert.equal((await client.messages.batches.list({ limit: 20 })).data.length, 1);
  assert.equal((await client.messages.batches.retrieve(batch.id)).processing_status, "ended");
  assert.equal((await client.messages.batches.cancel(batch.id)).processing_status, "canceling");
  const results = await client.messages.batches.results(batch.id);
  assert.deepEqual(results.map((r) => r.result.type), ["succeeded", "errored"]);
  await assert.rejects(client.messages.batches.retrieve("msgbatch_missing"), NotFoundError);

  for (const r of fake.requests) {
    assert.equal(r.headers.authorization, `Bearer ${FAKE_KEY}`);
    assert.equal(r.headers["x-api-key"], undefined);
  }
});

test("429 and 503 are retried after Retry-After, and a batch create keeps its Idempotency-Key", async () => {
  const client = new Orbtr({ apiKey: FAKE_KEY, baseURL: fake.url });
  const before429 = fake.requests.length;
  const msg = await client.messages.create(
    { model: "orbtr-model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    { headers: { "X-Fake-Scenario": "retry-429:a" } },
  );
  assert.equal(msg.id, "msg_sdk_01");
  assert.equal(fake.requests.length - before429, 2);

  const beforeBatch = fake.requests.length;
  await client.messages.batches.create({ requests: [] }, { headers: { "X-Fake-Scenario": "retry-503:b" } });
  const sent = fake.requests.slice(beforeBatch);
  assert.equal(sent.length, 2);
  assert.ok(sent[0]!.headers["idempotency-key"]);
  assert.equal(sent[0]!.headers["idempotency-key"], sent[1]!.headers["idempotency-key"]);
});

test("a wrong key raises AuthenticationError without a retry", async () => {
  const client = new Orbtr({ apiKey: "wrong", baseURL: fake.url });
  const n = fake.requests.length;
  await assert.rejects(client.models.list(), (err: unknown) => err instanceof AuthenticationError && err.code === "invalid_api_key");
  assert.equal(fake.requests.length - n, 1);
});

test("an error event ends a stream with StreamError", async () => {
  const client = new Orbtr({ apiKey: FAKE_KEY, baseURL: fake.url });
  const stream = await client.messages.stream(
    { model: "orbtr-model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] },
    { headers: { "X-Fake-Scenario": "stream-error" } },
  );
  await assert.rejects(stream.finalMessage(), (err: unknown) => err instanceof StreamError && err.code === "api_error");
});

test("every example runs against the fake", async () => {
  const dir = join(repoRoot, "build-test", "examples");
  const env = {
    ...process.env,
    ORBTR_API_KEY: FAKE_KEY,
    ORBTR_BASE_URL: fake.url,
    ORBTR_MODEL: "orbtr-model-1",
    ORBTR_FLOW_ID: "partition:p1:flow:council",
    ORBTR_FLOW_VERSION: "2",
  };
  const expected: Record<string, RegExp> = {
    "send-message.js": /orbtr-model-1\n[\s\S]*The sea is wide and grey\./,
    "stream-reply.js": /The sea is wide and grey\./,
    "count-tokens.js": /input tokens: 14\ncontext length: 131072/,
    "chat-completions.js": /The sea is wide and grey\./,
    "flow-model.js": /the council agrees\nflow partition:p1:flow:council version 2: 7 OT over 2 steps/,
  };
  const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual(files, Object.keys(expected).sort());
  for (const f of files) {
    const { stdout } = await run(process.execPath, [join(dir, f)], { env, cwd: repoRoot });
    assert.match(stdout, expected[f]!, f);
  }
});
