// #1008 — a real SSE server on 127.0.0.1 and a client that can stop reading (its socket paused).
import {
  createServer,
  request,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { sendEvents } from "../../../../src/a2a/server/a2a-http-io.js";
import type { Clock } from "../../../../src/infrastructure/clock.js";

/** A server whose one route answers `events` as server-sent events; the response is kept. */
export interface SseServer {
  readonly port: number;
  /** The server side's response of the last request. */
  readonly response: () => ServerResponse | undefined;
  /** Resolves when the server side finished answering. */
  readonly answered: () => Promise<void>;
  readonly close: () => Promise<void>;
}

export async function sseServer(
  events: (hungUp: AbortSignal) => AsyncIterable<unknown>,
  clock: Clock,
): Promise<SseServer> {
  let last: ServerResponse | undefined;
  let done: Promise<void> = Promise.resolve();
  const server: Server = createServer((_req, res) => {
    last = res;
    const hungUp = new AbortController();
    res.once("close", () => {
      hungUp.abort();
    });
    done = sendEvents(res, events(hungUp.signal), {
      id: 1,
      log: { error: () => undefined },
      clock,
      headers: {},
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    response: () => last,
    answered: () => done,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** The client's side of one request: the response, once its headers came. */
export function sseClient(port: number): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/", method: "GET" }, resolve);
    req.once("error", reject);
    req.end();
  });
}

/** What the client has received, and a wait for text in it. */
export interface Received {
  readonly text: () => string;
  /** Resolves once what was received (so far or later) includes `text`. */
  readonly until: (text: string) => Promise<void>;
}

/** Starts reading the client's response. */
export function received(res: IncomingMessage): Received {
  let seen = "";
  const waiting: { text: string; resolve: () => void }[] = [];
  res.on("data", (chunk: Buffer) => {
    seen += chunk.toString("utf8");
    for (const wait of waiting) if (seen.includes(wait.text)) wait.resolve();
  });
  return {
    text: () => seen,
    until: (text) =>
      seen.includes(text)
        ? Promise.resolve()
        : new Promise((resolve) => waiting.push({ text, resolve })),
  };
}
