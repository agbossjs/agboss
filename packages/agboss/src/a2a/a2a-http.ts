import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Class } from "../components/injection.js";
import type { IA2AAdapter } from "./a2a-adapter.js";
import { A2ARequestSchema, type A2AEvent, type A2AExecutionResponse } from "./types.js";

const ResumeSchema = z.object({ pauseId: z.string(), decision: z.unknown() });

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;

type Exchange = (
  body: unknown,
  onEvent: ((event: A2AEvent) => void) | undefined,
  signal: AbortSignal,
) => Promise<A2AExecutionResponse> | undefined;

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
};

const sseLine = (event: A2AEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** Runs one exchange: JSON in, then JSON out — or server-sent events when the caller accepts them. */
async function answer(req: IncomingMessage, res: ServerResponse, exchange: Exchange) {
  const aborted = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) aborted.abort(new Error("the caller disconnected"));
  });
  const streaming = (req.headers.accept ?? "").includes("text/event-stream");
  const onEvent = streaming ? (event: A2AEvent) => res.write(sseLine(event)) : undefined;
  if (streaming) res.writeHead(HTTP_OK, { "content-type": "text/event-stream" });
  const pending = exchange(await bodyOf(req).catch(() => null), onEvent, aborted.signal);
  if (pending === undefined) {
    if (streaming) res.end();
    else sendJson(res, HTTP_BAD_REQUEST, { error: "invalid A2A request" });
    return;
  }
  const result = await pending;
  if (streaming) res.end(sseLine({ type: "finish", payload: { result } }));
  else sendJson(res, HTTP_OK, result);
}

/**
 * The adapter over HTTP, for `http.createServer(a2aHttpListener(adapter, Start))`:
 * `POST <base>/execute` `{ input, thread? }` and `POST <base>/resume` `{ pauseId, decision }`.
 * The reply is the `A2AExecutionResponse` as JSON, or — with `Accept: text/event-stream` — progress
 * events followed by one `finish` event carrying it. A caller that disconnects cancels its run.
 */
export function a2aHttpListener(
  adapter: IA2AAdapter,
  start: Class,
  base = "",
): (req: IncomingMessage, res: ServerResponse) => void {
  const routes: Record<string, Exchange> = {
    [`${base}/execute`]: (body, onEvent, signal) => {
      const parsed = A2ARequestSchema.safeParse(body);
      return parsed.success ? adapter.execute(start, parsed.data, onEvent, { signal }) : undefined;
    },
    [`${base}/resume`]: (body, onEvent, signal) => {
      const parsed = ResumeSchema.safeParse(body);
      return parsed.success ? adapter.resume(parsed.data, onEvent, { signal }) : undefined;
    },
  };
  return (req, res) => {
    const exchange = req.method === "POST" ? routes[req.url ?? ""] : undefined;
    if (exchange === undefined) {
      sendJson(res, HTTP_NOT_FOUND, { error: `no A2A route ${req.method ?? ""} ${req.url ?? ""}` });
      return;
    }
    answer(req, res, exchange).catch(() => res.destroy());
  };
}
