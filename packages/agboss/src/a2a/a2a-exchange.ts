import type { IncomingMessage, ServerResponse } from "node:http";
import type { A2ACallOptions } from "./a2a-adapter.js";
import type { A2AEvent, A2AExecutionResponse } from "./types.js";

/**
 * One request's answer (#387, #398): its body read as text first (the envelope's `bodyHash` is of
 * it), then the run — JSON out, or server-sent events when the caller accepts them. A caller that
 * disconnects cancels its run.
 */

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;

/** One request's call into the adapter, for its caller; `undefined` when the body is invalid. */
export type Exchange = (
  body: unknown,
  onEvent: ((event: A2AEvent) => void) | undefined,
  options: A2ACallOptions,
) => Promise<A2AExecutionResponse> | undefined;

/** A request's body as it came. */
export async function bodyTextOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** The body's JSON; `null` when it is none. */
export function jsonOf(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const sseLine = (event: A2AEvent): string => `data: ${JSON.stringify(event)}\n\n`;

const isStreaming = (req: IncomingMessage): boolean =>
  (req.headers.accept ?? "").includes("text/event-stream");

/** A finished answer sent again (a repeat of a trusted request's key): JSON or one `finish` event. */
export function sendAnswer(req: IncomingMessage, res: ServerResponse, result: unknown): void {
  if (!isStreaming(req)) {
    sendJson(res, HTTP_OK, result);
    return;
  }
  res.writeHead(HTTP_OK, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ type: "finish", payload: { result } })}\n\n`);
}

/** What one answer runs: its exchange, options and body, and what its result becomes once sent. */
export interface AnswerSite {
  readonly exchange: Exchange;
  readonly options: A2ACallOptions;
  readonly body: unknown;
  /** The result as sent (a run report added) and kept (a trusted request's answer). */
  readonly settle: (result: A2AExecutionResponse) => Promise<A2AExecutionResponse>;
}

/** Runs one exchange and answers: JSON, or server-sent events when the caller accepts them. */
export async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  site: AnswerSite,
): Promise<A2AExecutionResponse | undefined> {
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort(new Error("the caller disconnected"));
  });
  const streaming = isStreaming(req);
  const onEvent = streaming ? (event: A2AEvent) => res.write(sseLine(event)) : undefined;
  // the caller's values are the start's (the options tie the resolver to it): the app checks them
  const pending = site.exchange(site.body, onEvent, { ...site.options, signal: aborted.signal });
  if (pending === undefined) {
    sendJson(res, HTTP_BAD_REQUEST, { error: "invalid A2A request" });
    return undefined;
  }
  if (streaming) res.writeHead(HTTP_OK, { "content-type": "text/event-stream" });
  const result = await site.settle(await pending);
  if (streaming) res.end(sseLine({ type: "finish", payload: { result } }));
  else sendJson(res, HTTP_OK, result);
  return result;
}
