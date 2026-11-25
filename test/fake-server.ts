// A local fake of api.orbtr.ai's /v1 surface for the integration test. Each route answers with the body
// recorded from its handler (fixtures/), after the checks api.orbtr.ai makes that a client can get wrong:
// the bearer key, the JSON body, the Idempotency-Key a batch create needs and refuses elsewhere, and a flow
// id the key cannot read. The X-Fake-Scenario header scripts failures: "retry-429" and "retry-503" fail the
// first call of a scenario id ("<kind>:<id>") with Retry-After: 0, and "stream-error" ends a stream with an
// error event.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { fixture } from "./helpers.js";

export const FAKE_KEY = "test-key";

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface Fake {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

function send(res: ServerResponse, name: string, overrideStatus?: number): void {
  const fx = fixture(name);
  res.writeHead(overrideStatus ?? fx.response.status, fx.response.headers);
  res.end(fx.response.body);
}

function sendJSON(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const FLOW = "partition:p1:flow:council";

export async function startFake(): Promise<Fake> {
  const requests: FakeRequest[] = [];
  const failed = new Set<string>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake");
    let body: unknown;
    if (raw !== "") {
      try {
        body = JSON.parse(raw);
      } catch {
        return sendJSON(res, 400, { type: "error", error: { type: "invalid_request_error", message: "request body is not valid JSON" } });
      }
    }
    requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });

    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) return send(res, "error-missing-bearer-token");
    if (auth !== `Bearer ${FAKE_KEY}`) return sendJSON(res, 401, { error: "invalid_api_key" });

    const scenario = String(req.headers["x-fake-scenario"] ?? "");
    const [kind] = scenario.split(":");
    if ((kind === "retry-429" || kind === "retry-503") && !failed.has(scenario)) {
      failed.add(scenario);
      if (kind === "retry-429") {
        return sendJSON(res, 429, { type: "error", error: { type: "partition_inflight_exceeded", message: "too many concurrent inference requests for this partition" } }, { "Retry-After": "0" });
      }
      return sendJSON(res, 503, { type: "error", error: { type: "no_servable_placement", message: "nothing can serve the model now" } }, { "Retry-After": "0" });
    }

    const b = (body ?? {}) as { model?: string; stream?: boolean };
    const route = `${req.method} ${url.pathname}`;
    const idem = req.headers["idempotency-key"];
    if (idem !== undefined && route !== "POST /v1/messages/batches" && route !== "POST /v1/messages/count_tokens" && !route.endsWith("/cancel")) {
      return sendJSON(res, 400, { type: "error", error: { type: "invalid_request_error", message: "this route takes no Idempotency-Key" } });
    }
    const isFlow = typeof b.model === "string" && b.model.startsWith("partition:") && b.model.includes(":flow:");
    if (isFlow && b.model!.split("@")[0] !== FLOW) return send(res, "error-flow-not-found");

    switch (route) {
      case "GET /v1/models":
        return send(res, "models-list");
      case "POST /v1/messages":
        if (b.stream && kind === "stream-error") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          const start = fixture("messages-stream").response.body.split("\n\n")[0];
          res.end(`${start}\n\nevent: error\ndata: {"type":"error","error":{"type":"api_error","message":"inference stream failed"}}\n\n`);
          return;
        }
        if (isFlow) return send(res, b.stream ? "messages-stream-flow" : "messages-create-flow");
        return send(res, b.stream ? "messages-stream" : "messages-create");
      case "POST /v1/messages/count_tokens":
        return send(res, "messages-count-tokens");
      case "POST /v1/embeddings":
        return send(res, "embeddings-create");
      case "POST /v1/chat/completions":
        if (isFlow) return send(res, "chat-completions-create-flow");
        return send(res, b.stream ? "chat-completions-stream" : "chat-completions-create");
      case "POST /v1/completions":
        return send(res, "completions-create");
      case "POST /v1/messages/batches":
        if (!idem) return sendJSON(res, 400, { type: "error", error: { type: "invalid_request_error", message: "Idempotency-Key is required" } });
        return send(res, "batches-create");
      case "GET /v1/messages/batches":
        return send(res, "batches-list");
    }
    const m = /^\/v1\/messages\/batches\/([^/]+)(\/cancel|\/results)?$/.exec(url.pathname);
    if (m) {
      if (m[1] !== "msgbatch_sdk_01") return sendJSON(res, 404, { type: "error", error: { type: "not_found_error", message: "message batch not found" } });
      if (req.method === "GET" && !m[2]) return send(res, "batches-retrieve");
      if (req.method === "POST" && m[2] === "/cancel") return send(res, "batches-cancel");
      if (req.method === "GET" && m[2] === "/results") return send(res, "batches-results");
    }
    return sendJSON(res, 404, { type: "error", error: { type: "not_found_error", message: `no route ${route}` } });
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => sendJSON(res, 500, { type: "error", error: { type: "api_error", message: String(err) } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
