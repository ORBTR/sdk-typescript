// Fixture loading and a fetch that answers from one fixture while recording what the SDK sent. The fixtures
// in fixtures/ are HTTP exchanges recorded from api.orbtr.ai's handlers; each names the handler it came from.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface Fixture {
  name: string;
  description: string;
  recorded_from: string;
  request: { method: string; path: string; query?: string; body?: unknown };
  response: { status: number; headers: Record<string, string>; body: string };
}

export function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(repoRoot, "fixtures", `${name}.json`), "utf8")) as Fixture;
}

export function fixtureNames(): string[] {
  return readdirSync(join(repoRoot, "fixtures"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

export interface SentRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

/** Splits a body into chunks of the given size, so stream parsing meets events cut across reads. */
function chunked(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
}

/** A fetch answering each call with the next of the given fixtures; every request is kept in sent. */
export function fixtureFetch(...names: string[]): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const queue = names.map(fixture);
  const f = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const fx = queue.shift();
    if (!fx) throw new Error("no fixture left for this request");
    const raw = init?.body;
    sent.push({
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    });
    return new Response(chunked(fx.response.body, 7), { status: fx.response.status, headers: fx.response.headers });
  };
  return { fetch: f as typeof fetch, sent };
}
