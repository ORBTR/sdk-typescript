# ORBTR SDK for TypeScript and JavaScript

`@orbtr/sdk` calls api.orbtr.ai: messages, streaming, models, flows as models, token counting, embeddings,
OpenAI-compatible chat and completions, and message batches.

Its types and calls are generated from the API contract api.orbtr.ai serves (`contract/orbtr-v1.json`); a
small hand-written layer adds the API key, the base URL, streaming, retries and typed errors.

## Install

```bash
npm install @orbtr/sdk
```

Node.js 22 or later. The package is an ES module and has no runtime dependencies.

## Make a client

```ts
import Orbtr from "@orbtr/sdk";

const client = new Orbtr(); // reads ORBTR_API_KEY
```

Make an API key at [manage.orbtr.ai/api_keys](https://manage.orbtr.ai/api_keys). The client sends it as
`Authorization: Bearer <key>`. Each call needs the key to carry the scope the call names
(`orbtr.inference.invoke` to send messages, `orbtr.inference.read` to list models and count tokens, and
`orbtr.messages.batch.*` for batches).

| Option | Default | What it does |
|---|---|---|
| `apiKey` | `ORBTR_API_KEY` | The API key. |
| `baseURL` | `ORBTR_BASE_URL`, then `https://api.orbtr.ai` | The API origin. |
| `maxRetries` | `2` | Retries after a 429, a 5xx or a connection failure. |
| `timeout` | `600000` | Milliseconds a call may take. |
| `defaultHeaders` | none | Headers sent with every call. |
| `fetch` | the global `fetch` | The fetch implementation. |

## Send a message

```ts
const models = await client.models.list();
const message = await client.messages.create({
  model: models.data[0].id,
  max_tokens: 256,
  messages: [{ role: "user", content: "Write one sentence about the sea." }],
});
console.log(message.content[0].text);
```

## Stream a reply

```ts
const stream = await client.messages.stream({
  model: "MODEL_ID",
  max_tokens: 512,
  messages: [{ role: "user", content: "Explain what a Space is in three sentences." }],
});
for await (const event of stream) {
  if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
    process.stdout.write(event.delta.text ?? "");
  }
}
```

The events follow the Anthropic Messages streaming format. `await stream.finalMessage()` gathers them into the
whole reply, and `stream.abort()` closes the stream early. `client.chat.completions.stream(...)` and
`client.completions.stream(...)` stream the OpenAI-compatible routes, ending at `[DONE]`.

## Call a flow as a model

A published flow answers as a model. Name its id as the `model`; pin a published version with `flowModel`:

```ts
import { flowModel } from "@orbtr/sdk";

const reply = await client.messages.create({
  model: flowModel("partition:PARTITION:flow:NAME", 2), // "…@2"; leave the version out for the newest
  max_tokens: 1024,
  messages: [{ role: "user", content: "Review this paragraph for tone." }],
});
console.log(reply.usage.orbtr); // the version that answered, the run's OT and one line per step
```

## Count tokens

```ts
const { input_tokens } = await client.messages.countTokens({
  model: "MODEL_ID",
  messages: [{ role: "user", content: "How long is this request?" }],
});
```

## Embeddings, OpenAI-compatible calls and batches

```ts
await client.embeddings.create({ model: "EMBEDDING_MODEL_ID", input: ["the sea", "the sky"] });
await client.chat.completions.create({ model: "MODEL_ID", messages: [{ role: "user", content: "Hello" }] });

const batch = await client.messages.batches.create({
  requests: [{ custom_id: "first", params: { model: "MODEL_ID", max_tokens: 64, messages: [{ role: "user", content: "Hello" }] } }],
});
const results = await client.messages.batches.results(batch.id); // one result per request
```

Creating a batch sends an `Idempotency-Key`, the same on every retry, so a retried create never makes a second
batch. Pass `{ idempotencyKey }` as the call's options to choose it.

## Errors and retries

A refused call raises an `APIError` subclass carrying `status`, `code` (such as `invalid_api_key` or
`insufficient_ot`), `body` and `headers`:

| Status | Error |
|---|---|
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` (`reason` says whether a key was revoked, rotated or expired) |
| 402 | `PaymentRequiredError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 422 | `UnprocessableEntityError` |
| 429 | `RateLimitError` |
| 5xx | `InternalServerError` |

`APIConnectionError` and `APITimeoutError` mean no response arrived; `StreamError` means a stream failed after it
began. A 429, a 5xx and a connection failure are retried up to `maxRetries` times, waiting as long as a
`Retry-After` header asks (up to 60 seconds; a longer wait is raised to you instead) or, without one, backing
off from half a second to eight. Every call takes options to change this: `{ maxRetries, timeout, headers,
signal }`.

## Examples

`examples/` holds one program per recipe on [docs.orbtr.ai](https://docs.orbtr.ai/recipes/index):
`send-message.ts`, `stream-reply.ts`, `count-tokens.ts`, `chat-completions.ts` and `flow-model.ts`.

## Developing

```bash
npm ci
npm test               # unit tests against recorded fixtures, then the integration test against a local fake
npm run generate       # regenerate src/generated from contract/orbtr-v1.json
```

`fixtures/` holds HTTP exchanges recorded from api.orbtr.ai's handlers, each naming the handler it came from.
Commits follow Conventional Commits; release-please turns them into versions and `CHANGELOG.md`.

## Licence

Proprietary. See [LICENSE](LICENSE): you may use this package with an ORBTR account under ORBTR's Terms of
Service.
