/** #808 — raw JSON-RPC 2.0 calls of an A2A listener, the way every client sends them. */

/** What a call sends besides its method and params. */
export interface RpcOptions {
  /** The bearer token's owner; `null`: no token. Default `dana`. */
  readonly owner?: string | null;
  /** `A2A-Version`; `null`: none. Default `1.0`. */
  readonly version?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

/** A call's HTTP answer: its status, headers and parsed JSON body. */
export interface RpcAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const headersOf = (options: RpcOptions): Record<string, string> => ({
  "content-type": "application/json",
  ...(options.owner === null ? {} : { authorization: `Bearer ${options.owner ?? "dana"}` }),
  ...(options.version === null ? {} : { "a2a-version": options.version ?? "1.0" }),
  ...options.headers,
});

let ids = 0;

/** One JSON-RPC request's body. */
export const rpcBody = (method: string, params: unknown): string =>
  JSON.stringify({ jsonrpc: "2.0", id: (ids += 1), method, params });

/** Posts a raw body. */
export async function post(
  url: string,
  body: string,
  options: RpcOptions = {},
): Promise<RpcAnswer> {
  const response = await fetch(url, {
    method: "POST",
    headers: headersOf(options),
    body,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const text = await response.text();
  const parsed: unknown = text === "" ? {} : JSON.parse(text);
  return {
    status: response.status,
    headers: response.headers,
    body: parsed as Record<string, unknown>,
  };
}

/** Calls `method` with `params`. */
export const rpc = (
  url: string,
  method: string,
  params: unknown,
  options: RpcOptions = {},
): Promise<RpcAnswer> => post(url, rpcBody(method, params), options);

/** The `error` of a JSON-RPC answer. */
export const errorOf = (answer: RpcAnswer): { code: number; message: string; data?: unknown } =>
  answer.body.error as { code: number; message: string; data?: unknown };

/** The `metadata` of a JSON-RPC error's `ErrorInfo`. */
export const errorInfoOf = (answer: RpcAnswer): Record<string, string> | undefined => {
  const data = errorOf(answer).data;
  return Array.isArray(data)
    ? (data[0] as { metadata?: Record<string, string> }).metadata
    : undefined;
};

/** A user message's ProtoJSON. */
export const userMessage = (
  messageId: string,
  parts: readonly unknown[],
  fields: {
    readonly taskId?: string;
    readonly contextId?: string;
    readonly metadata?: unknown;
  } = {},
): Record<string, unknown> => ({ messageId, role: "ROLE_USER", parts, ...fields });

/** A part's ProtoJSON. */
export interface WirePart {
  readonly mediaType: string;
  readonly text?: string;
  readonly data?: unknown;
}

export const text = (value: string): WirePart => ({ text: value, mediaType: "text/plain" });
export const data = (value: unknown): WirePart => ({ data: value, mediaType: "application/json" });

/** Reads server-sent events: each `data:` line's JSON, until the stream ends or `count` are read. */
export async function sseEvents(
  url: string,
  method: string,
  params: unknown,
  options: RpcOptions & { readonly count?: number } = {},
): Promise<{
  readonly status: number;
  readonly contentType: string;
  readonly events: Record<string, unknown>[];
}> {
  const abort = new AbortController();
  const signal =
    options.signal === undefined ? abort.signal : AbortSignal.any([abort.signal, options.signal]);
  const response = await fetch(url, {
    method: "POST",
    headers: headersOf(options),
    body: rpcBody(method, params),
    signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const events: Record<string, unknown>[] = [];
  if (!contentType.includes("text/event-stream")) {
    events.push(JSON.parse(await response.text()) as Record<string, unknown>);
    return { status: response.status, contentType, events };
  }
  try {
    await readEvents(response, events, options.count);
  } finally {
    abort.abort(); // the caller hangs up
  }
  return { status: response.status, contentType, events };
}

/** Takes the complete `data:` events out of `buffered` into `events`; the rest is returned. */
function takenEvents(buffered: string, events: Record<string, unknown>[]): string {
  let rest = buffered;
  for (let end = rest.indexOf("\n\n"); end !== -1; end = rest.indexOf("\n\n")) {
    const line = rest
      .slice(0, end)
      .split("\n")
      .find((entry) => entry.startsWith("data: "));
    if (line !== undefined) events.push(JSON.parse(line.slice(6)) as Record<string, unknown>);
    rest = rest.slice(end + 2);
  }
  return rest;
}

/** Reads a stream's events until it ends or `count` are read. */
async function readEvents(
  response: Response,
  events: Record<string, unknown>[],
  count: number | undefined,
): Promise<void> {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  const decoder = new TextDecoder();
  let buffered = "";
  while (count === undefined || events.length < count) {
    const { value, done } = await reader.read();
    if (done) return;
    buffered = takenEvents(buffered + decoder.decode(value, { stream: true }), events);
  }
}

/** Waits until `isMet()` resolves `true`, one event-loop turn between reads, bounded in real time. */
export async function eventually(
  isMet: () => Promise<boolean>,
  what: string,
  timeout = 4000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await isMet())) {
    if (Date.now() > deadline) throw new Error(`${what} within ${String(timeout)} ms of real time`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
