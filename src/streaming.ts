// Server-sent event streams: the line decoder, the stream every streamed call returns, and MessageStream,
// which also gathers a Messages stream's events into the final Message.
// Consumes: a fetch Response whose body is text/event-stream, from core.ts.
// Conditions: a Messages stream yields each event's JSON data, with its type, for the Anthropic event types,
// and { type, data } for any other event name (ORBTR's orbtr.ai.* progress events); an error event raises
// StreamError. An OpenAI-compatible stream yields each data line's JSON until data: [DONE].

import { StreamError } from "./errors.js";
import type { ContentBlock, Message, MessageStreamEvent } from "./generated/types.js";

/** One decoded server-sent event. */
export interface ServerSentEvent {
  event: string | undefined;
  data: string;
  id: string | undefined;
}

/** Splits a byte stream into server-sent events, following the event-stream format: lines end in LF, CR or
 * CRLF; a blank line ends an event; a line starting with a colon is a comment; data lines join with LF. */
export class SSEDecoder {
  private buffer = "";
  private event: string | undefined;
  private data: string[] = [];
  private id: string | undefined;
  private readonly text = new TextDecoder();

  /** Decodes one chunk and returns the events it completes. */
  push(chunk: Uint8Array): ServerSentEvent[] {
    this.buffer += this.text.decode(chunk, { stream: true });
    return this.drain(false);
  }

  /** Returns the events still buffered when the body ends. */
  end(): ServerSentEvent[] {
    this.buffer += this.text.decode();
    return this.drain(true);
  }

  private drain(final: boolean): ServerSentEvent[] {
    const out: ServerSentEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A CR at the buffer's end may be the first half of a CRLF split across chunks.
      if (m[0] === "\r" && m.index === this.buffer.length - 1 && !final) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    if (final) {
      if (this.buffer !== "") {
        const ev = this.line(this.buffer);
        this.buffer = "";
        if (ev) out.push(ev);
      }
      const ev = this.line("");
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): ServerSentEvent | undefined {
    if (line === "") {
      if (this.data.length === 0 && this.event === undefined) return undefined;
      const ev = { event: this.event, data: this.data.join("\n"), id: this.id };
      this.event = undefined;
      this.data = [];
      return ev;
    }
    if (line.startsWith(":")) return undefined;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
    return undefined;
  }
}

/** What a parser makes of one event: a value to yield, nothing to yield, or the stream's end. */
export type ParseResult<T> = { value: T } | { skip: true } | { done: true };

/** An event a Messages stream carries beyond the Anthropic event types, such as orbtr.ai.turn.started. */
export interface ExtensionStreamEvent {
  type: `orbtr.${string}`;
  data: unknown;
}

const MESSAGE_EVENT_TYPES = new Set([
  "message_start",
  "content_block_start",
  "content_block_delta",
  "content_block_stop",
  "message_delta",
  "message_stop",
  "ping",
]);

function parseJSON(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function streamError(data: unknown): StreamError {
  const e = (data as { error?: { type?: string; code?: string; message?: string } } | undefined)?.error;
  const code = e?.code || e?.type;
  return new StreamError(code, e?.message ?? "The stream failed", data);
}

/** Parses a Messages stream's events. */
export function messageEventParser(): (ev: ServerSentEvent) => ParseResult<MessageStreamEvent | ExtensionStreamEvent> {
  return (ev) => {
    const data = parseJSON(ev.data);
    const name = ev.event ?? (data as { type?: string } | undefined)?.type;
    if (name === "error") throw streamError(data);
    if (name === undefined) return { skip: true };
    if (MESSAGE_EVENT_TYPES.has(name) && data && typeof data === "object") {
      return { value: { ...(data as object), type: name } as MessageStreamEvent };
    }
    return { value: { type: name as ExtensionStreamEvent["type"], data } };
  };
}

/** Parses an OpenAI-compatible stream's data lines until [DONE]. */
export function chunkParser<T>(): (ev: ServerSentEvent) => ParseResult<T> {
  return (ev) => {
    if (ev.data === "[DONE]") return { done: true };
    if (ev.data === "") return { skip: true };
    const data = parseJSON(ev.data);
    if (data && typeof data === "object" && "error" in data && !("choices" in data)) throw streamError(data);
    return { value: data as T };
  };
}

/** A streamed reply: iterate it with for await. A stream can be iterated once; abort() closes it early. */
export class Stream<T> implements AsyncIterable<T> {
  /** The response the stream reads. */
  readonly response: Response;
  private readonly controller: AbortController;
  private readonly parse: (ev: ServerSentEvent) => ParseResult<T>;
  private readonly done: () => void;
  /** Whether iteration has begun; a stream is read once. */
  protected consumed = false;

  constructor(response: Response, controller: AbortController, parse: (ev: ServerSentEvent) => ParseResult<T>, done: () => void = () => {}) {
    this.response = response;
    this.controller = controller;
    this.parse = parse;
    this.done = done;
  }

  /** Closes the stream and its connection. */
  abort(): void {
    this.controller.abort();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consumed) throw new Error("A stream can be iterated only once.");
    this.consumed = true;
    const body = this.response.body;
    if (!body) return;
    const reader = body.getReader();
    const decoder = new SSEDecoder();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const events = done ? decoder.end() : decoder.push(value);
        for (const ev of events) {
          const r = this.parse(ev);
          if ("done" in r) {
            finished = true;
            return;
          }
          if ("value" in r) yield this.observe(r.value);
        }
        if (done) {
          finished = true;
          return;
        }
      }
    } finally {
      if (!finished) this.controller.abort();
      reader.releaseLock();
      this.done();
    }
  }

  /** Called with each value before it is yielded. */
  protected observe(value: T): T {
    return value;
  }
}

/** A streamed Messages reply. Besides its events, it gathers the reply: finalMessage() resolves to the
 * Message the events describe once the stream ends. */
export class MessageStream extends Stream<MessageStreamEvent | ExtensionStreamEvent> {
  private message: Message | undefined;
  private readonly partialJSON = new Map<number, string>();

  constructor(response: Response, controller: AbortController, done?: () => void) {
    super(response, controller, messageEventParser(), done);
  }

  /** The reply as gathered so far, or undefined before message_start. */
  get currentMessage(): Message | undefined {
    return this.message;
  }

  /** Reads the rest of the stream and resolves to the whole reply. */
  async finalMessage(): Promise<Message> {
    if (!this.consumed) {
      // Iterating runs observe on each event, which gathers the reply.
      for await (const _ of this);
    }
    if (!this.message) throw new StreamError(undefined, "The stream ended before message_start", undefined);
    return this.message;
  }

  /** Reads the rest of the stream and resolves to the reply's text. */
  async finalText(): Promise<string> {
    const m = await this.finalMessage();
    return m.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  protected override observe(ev: MessageStreamEvent | ExtensionStreamEvent): MessageStreamEvent | ExtensionStreamEvent {
    switch (ev.type) {
      case "message_start":
        this.message = { ...ev.message, content: [...(ev.message.content ?? [])], usage: { ...ev.message.usage } };
        break;
      case "content_block_start":
        if (this.message) this.message.content[ev.index] = { ...ev.content_block } as ContentBlock;
        break;
      case "content_block_delta": {
        const block = this.message?.content[ev.index];
        if (!block) break;
        if (ev.delta.type === "text_delta") block.text = (block.text ?? "") + (ev.delta.text ?? "");
        if (ev.delta.type === "input_json_delta") {
          this.partialJSON.set(ev.index, (this.partialJSON.get(ev.index) ?? "") + (ev.delta.partial_json ?? ""));
        }
        break;
      }
      case "content_block_stop": {
        const json = this.partialJSON.get(ev.index);
        const block = this.message?.content[ev.index];
        if (block && json !== undefined && json !== "") block.input = JSON.parse(json) as { [key: string]: unknown };
        this.partialJSON.delete(ev.index);
        break;
      }
      case "message_delta":
        if (this.message) {
          if (ev.delta.stop_reason !== undefined) this.message.stop_reason = ev.delta.stop_reason;
          if (ev.delta.stop_sequence !== undefined) this.message.stop_sequence = ev.delta.stop_sequence;
          if (ev.usage) this.message.usage = { ...this.message.usage, ...ev.usage };
        }
        break;
    }
    return ev;
  }
}
