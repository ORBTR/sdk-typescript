// The errors every call can raise. core.ts builds an APIError subclass from a refused response's status and
// body; streaming.ts raises StreamError when a stream reports a failure after it began.

/** The base of every error this SDK raises. */
export class OrbtrError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A response api.orbtr.ai refused, with its status, its error code and its parsed body. */
export class APIError extends OrbtrError {
  /** The HTTP status. */
  readonly status: number;
  /** The error code the body names, such as invalid_api_key or insufficient_ot. */
  readonly code: string | undefined;
  /** The parsed JSON body, or the raw text when it is not JSON. */
  readonly body: unknown;
  /** The response headers. */
  readonly headers: Headers;
  /** The reason a key_expired_or_revoked refusal names (revoked, rotated or expired). */
  readonly reason: string | undefined;

  constructor(status: number, code: string | undefined, message: string, body: unknown, headers: Headers, reason?: string) {
    super(code && !message.startsWith(code) ? `${status} ${code}: ${message}` : `${status} ${message}`);
    this.status = status;
    this.code = code;
    this.body = body;
    this.headers = headers;
    this.reason = reason;
  }
}

/** 400: the request is malformed. */
export class BadRequestError extends APIError {}
/** 401: the key is missing, unknown, revoked, rotated or expired. */
export class AuthenticationError extends APIError {}
/** 402: the OT balance or a spending bound is short. */
export class PaymentRequiredError extends APIError {}
/** 403: the key lacks the scope, the plan lacks the feature, or the request is above a limit. */
export class PermissionDeniedError extends APIError {}
/** 404: the model, flow or batch is unknown or not readable by the key. */
export class NotFoundError extends APIError {}
/** 409: the request conflicts with the conversation or an idempotency key. */
export class ConflictError extends APIError {}
/** 422: the request is well-formed but cannot be processed. */
export class UnprocessableEntityError extends APIError {}
/** 429: a rate, quota or budget limit refused the call. */
export class RateLimitError extends APIError {}
/** 5xx: the service failed or is overloaded. */
export class InternalServerError extends APIError {}

/** The request never received a response. */
export class APIConnectionError extends OrbtrError {
  constructor(message = "Connection error", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The request took longer than its timeout. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The caller aborted the request through its AbortSignal. */
export class APIUserAbortError extends OrbtrError {
  constructor(message = "Request was aborted") {
    super(message);
  }
}

/** A stream reported a failure after its response began. */
export class StreamError extends OrbtrError {
  /** The error code the stream named, such as api_error. */
  readonly code: string | undefined;
  /** The event's parsed data. */
  readonly body: unknown;

  constructor(code: string | undefined, message: string, body: unknown) {
    super(code ? `${code}: ${message}` : message);
    this.code = code;
    this.body = body;
  }
}

/** Reads the code, message and reason from the three error bodies api.orbtr.ai answers: the Anthropic shape
 * {"type":"error","error":{"type","message"}}, the OpenAI shape {"error":{"message","type","code"}} and the
 * key gateway's {"error":"<code>","reason"?}. */
export function describeErrorBody(body: unknown): { code?: string; message?: string; reason?: string } {
  if (!body || typeof body !== "object") return {};
  const b = body as Record<string, unknown>;
  const reason = typeof b.reason === "string" ? b.reason : undefined;
  if (typeof b.error === "string") {
    return { code: b.error, message: typeof b.message === "string" ? b.message : undefined, reason };
  }
  if (b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    const code = typeof e.code === "string" && e.code ? e.code : typeof e.type === "string" ? e.type : undefined;
    return { code, message: typeof e.message === "string" ? e.message : undefined, reason };
  }
  return { message: typeof b.message === "string" ? b.message : undefined, reason };
}

/** Builds the APIError subclass for a refused response. */
export function makeAPIError(status: number, body: unknown, text: string, headers: Headers): APIError {
  const { code, message, reason } = describeErrorBody(body);
  const msg = message ?? code ?? (text || `HTTP ${status}`);
  const args = [status, code, msg, body === undefined ? text : body, headers, reason] as const;
  switch (true) {
    case status === 400:
      return new BadRequestError(...args);
    case status === 401:
      return new AuthenticationError(...args);
    case status === 402:
      return new PaymentRequiredError(...args);
    case status === 403:
      return new PermissionDeniedError(...args);
    case status === 404:
      return new NotFoundError(...args);
    case status === 409:
      return new ConflictError(...args);
    case status === 422:
      return new UnprocessableEntityError(...args);
    case status === 429:
      return new RateLimitError(...args);
    case status >= 500:
      return new InternalServerError(...args);
    default:
      return new APIError(...args);
  }
}
