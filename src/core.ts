// The transport every generated resource calls: the base URL, the API key as a bearer token, timeouts, and
// retries with backoff on 429 and 5xx responses and on connection failures, honouring Retry-After.
// Consumes: ClientOptions from the caller and RequestSpec values built by src/generated/resources.ts.
// Consumed by: client.ts (Orbtr extends APIClient) and the generated resource classes.

import { APIConnectionError, APITimeoutError, APIUserAbortError, OrbtrError, makeAPIError } from "./errors.js";
import { MessageStream, Stream, chunkParser } from "./streaming.js";
import { VERSION } from "./version.js";

/** The default API origin. */
export const DEFAULT_BASE_URL = "https://api.orbtr.ai";
/** How many times a failed call is retried unless a client or call says otherwise. */
export const DEFAULT_MAX_RETRIES = 2;
/** How long a call may take, in milliseconds, unless a client or call says otherwise. */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** The longest Retry-After a retry waits for; a longer one is raised to the caller instead. */
export const MAX_RETRY_AFTER_MS = 60_000;
const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export interface ClientOptions {
  /** An ORBTR API key. Defaults to the ORBTR_API_KEY environment variable. */
  apiKey?: string;
  /** The API origin. Defaults to the ORBTR_BASE_URL environment variable, then https://api.orbtr.ai. */
  baseURL?: string;
  /** Retries after a 429, a 5xx or a connection failure. Defaults to 2. */
  maxRetries?: number;
  /** Milliseconds a call may take, retries apart. Defaults to 600000. */
  timeout?: number;
  /** Headers sent with every call. */
  defaultHeaders?: Record<string, string>;
  /** The fetch implementation. Defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** Per-call settings. */
export interface RequestOptions {
  /** Headers added to this call. */
  headers?: Record<string, string>;
  /** Milliseconds this call may take. */
  timeout?: number;
  /** Retries for this call. */
  maxRetries?: number;
  /** Aborts the call. */
  signal?: AbortSignal;
  /** The Idempotency-Key of a call that takes one (creating a message batch); one is made when absent, and
   * every retry of the call sends the same key. */
  idempotencyKey?: string;
}

/** One call as a generated resource describes it. */
export interface RequestSpec {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** The route keys the call on an Idempotency-Key, so a retry is safe to repeat. */
  idempotent?: boolean;
}

/** The base of every generated resource class. */
export class APIResource {
  protected readonly _client: APIClient;
  constructor(client: APIClient) {
    this._client = client;
  }
}

/** Returns params without the stream flag, so a non-streaming call never asks for a stream. */
export function withoutStream<T extends object>(params: T, flag: string): T {
  if (!(flag in params)) return params;
  const copy = { ...params } as Record<string, unknown>;
  delete copy[flag];
  return copy as T;
}

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return p?.env?.[name] || undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new APIUserAbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new APIUserAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return `orbtr-sdk-${c.randomUUID()}`;
  return `orbtr-sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Whether a response status is retried: 429 and every 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** The delay before retry number attempt (0 for the first retry): exponential from 0.5 s, capped at 8 s,
 * with up to a quarter taken off at random so clients refused together do not retry together. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base * (1 - 0.25 * random());
}

/** Reads Retry-After as seconds or an HTTP date. Returns undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** The client every resource calls through. */
export class APIClient {
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number;
  private readonly apiKey: string;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? env("ORBTR_API_KEY");
    if (!apiKey) {
      throw new OrbtrError("No API key: pass apiKey or set the ORBTR_API_KEY environment variable.");
    }
    this.apiKey = apiKey;
    this.baseURL = (options.baseURL ?? env("ORBTR_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.defaultHeaders = { ...(options.defaultHeaders ?? {}) };
    const f = options.fetch ?? (globalThis.fetch as typeof fetch | undefined);
    if (!f) throw new OrbtrError("No fetch implementation: pass options.fetch.");
    this.fetchImpl = f;
  }

  /** Sends a call and parses its JSON body. */
  async json<T>(spec: RequestSpec, options: RequestOptions = {}): Promise<T> {
    const { response, done } = await this.send(spec, options, "application/json");
    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new APIConnectionError("The response body could not be read", { cause: err });
    } finally {
      done();
    }
  }

  /** Sends a call whose body is newline-delimited JSON and parses every line. */
  async ndjson<T>(spec: RequestSpec, options: RequestOptions = {}): Promise<T[]> {
    const { response, done } = await this.send(spec, options, "application/x-ndjson");
    try {
      const text = await response.text();
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as T);
    } finally {
      done();
    }
  }

  /** Sends a Messages call whose reply arrives as server-sent events. */
  async messageStream(spec: RequestSpec, options: RequestOptions = {}): Promise<MessageStream> {
    const { response, controller, done } = await this.send(spec, options, "text/event-stream", true);
    return new MessageStream(response, controller, done);
  }

  /** Sends an OpenAI-compatible call whose reply arrives as server-sent chunks ended by [DONE]. */
  async chunkStream<T>(spec: RequestSpec, options: RequestOptions = {}): Promise<Stream<T>> {
    const { response, controller, done } = await this.send(spec, options, "text/event-stream", true);
    return new Stream<T>(response, controller, chunkParser<T>(), done);
  }

  private url(spec: RequestSpec): string {
    const u = new URL(this.baseURL + spec.path);
    for (const [k, v] of Object.entries(spec.query ?? {})) {
      if (v !== undefined) u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  /** Sends a call, retrying a 429, a 5xx or a connection failure up to maxRetries times. A Retry-After
   * header sets the wait when it is at most MAX_RETRY_AFTER_MS; a longer one ends the retries. The timeout
   * covers the whole call for a JSON body and the wait for the response headers for a stream. */
  private async send(
    spec: RequestSpec,
    options: RequestOptions,
    accept: string,
    streaming = false,
  ): Promise<{ response: Response; controller: AbortController; done: () => void }> {
    const maxRetries = options.maxRetries ?? this.maxRetries;
    const timeout = options.timeout ?? this.timeout;
    const idempotencyKey = spec.idempotent ? (options.idempotencyKey ?? newIdempotencyKey()) : undefined;
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": `orbtr-sdk-typescript/${VERSION}`,
      ...this.defaultHeaders,
      ...(options.headers ?? {}),
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const body = spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const url = this.url(spec);

    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeout);
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: spec.method, headers, body, signal: controller.signal });
      } catch (err) {
        done();
        if (options.signal?.aborted) throw new APIUserAbortError();
        if (attempt < maxRetries) {
          await sleep(backoffMs(attempt), options.signal);
          continue;
        }
        throw timedOut ? new APITimeoutError(undefined, { cause: err }) : new APIConnectionError(undefined, { cause: err });
      }
      if (response.ok) {
        if (streaming) clearTimeout(timer);
        return { response, controller, done };
      }
      if (isRetryableStatus(response.status) && attempt < maxRetries) {
        const after = parseRetryAfter(response.headers.get("retry-after"));
        if (after === undefined || after <= MAX_RETRY_AFTER_MS) {
          done();
          await response.body?.cancel().catch(() => {});
          await sleep(after ?? backoffMs(attempt), options.signal);
          continue;
        }
      }
      try {
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = text ? JSON.parse(text) : undefined;
        } catch {
          parsed = undefined;
        }
        throw makeAPIError(response.status, parsed, text, response.headers);
      } finally {
        done();
      }
    }
  }
}
