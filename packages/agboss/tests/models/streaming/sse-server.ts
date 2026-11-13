import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ProviderFetch } from "../../../src/models/resilient-fetch.js";

/** A real server on 127.0.0.1 that answers chat completions with server-sent events (#1005). */

/** A gate a script waits at until the test opens it. */
export class Gate {
  #open: () => void = () => undefined;
  readonly opened = new Promise<void>((resolve) => {
    this.#open = resolve;
  });

  open(): void {
    this.#open();
  }
}

/** One step of an answer: events written now, a wait, a cut socket, or a clean end. */
export type SseStep =
  | { readonly kind: "events"; readonly events: readonly unknown[] }
  | { readonly kind: "wait"; readonly gate: Gate }
  | { readonly kind: "cut" }
  | { readonly kind: "end" };

/** An answer: its status and steps; no `end` step ends the body after the last one. */
export interface SseScript {
  readonly status?: number;
  readonly steps: readonly SseStep[];
}

/** The request the server got. */
export interface ServedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

const events = (...list: unknown[]): SseStep => ({ kind: "events", events: list });

/** The usual answer of `tokens`, ended by a finish chunk, a usage chunk and `[DONE]`. */
export function streamOf(
  tokens: readonly string[],
  usage: Readonly<Record<string, number>> = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
  provider = "Acme",
): SseScript {
  return {
    steps: [
      events(chunk({ role: "assistant", content: "" }, provider)),
      ...tokens.map((token) => events(chunk({ content: token }, provider))),
      events(
        { ...chunk({}, provider), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { id: "c", model: "m", provider, choices: [], usage },
        "[DONE]",
      ),
    ],
  };
}

/** A plain (not streamed) completion of `text`, as the server answers a request without `stream`. */
export const plainOf = (
  text: string,
  usage: Readonly<Record<string, number>> = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  },
): unknown => ({
  id: "c",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage,
});

/** A chunk with `delta`. */
export const chunk = (
  delta: Record<string, unknown>,
  provider = "Acme",
): Record<string, unknown> => ({
  id: "c",
  model: "m",
  provider,
  choices: [{ index: 0, delta, finish_reason: null }],
});

export const sseEvents = events;

const body = (request: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
      resolve(
        typeof parsed === "object" && parsed !== null
          ? Object.fromEntries(Object.entries(parsed))
          : {},
      );
    });
  });

const frame = (event: unknown): string =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;

async function play(script: SseScript, response: ServerResponse): Promise<void> {
  response.writeHead(script.status ?? 200, { "content-type": "text/event-stream" });
  for (const step of script.steps) {
    if (step.kind === "wait") await step.gate.opened;
    if (step.kind === "events") for (const each of step.events) response.write(frame(each));
    if (step.kind === "cut") return void response.destroy();
    if (step.kind === "end") return void response.end();
    await new Promise((resolve) => setImmediate(resolve));
  }
  response.end();
}

/** The models every server lists (the startup check wants each used model listed). */
const MODELS = ["stream/model", "backup-stream/model", "cost-stream/model", "primary/model"];

/** The running server: its requests, a `send` that sends any URL to it, and `close`. */
export interface SseServer {
  /** Its address: `<url>/v1` is a provider's base URL. */
  readonly url: string;
  readonly requests: ServedRequest[];
  readonly send: ProviderFetch;
  close(): Promise<void>;
}

/** Starts the server; each chat completion takes the next script (the last repeats). */
export async function sseServer(scripts: readonly SseScript[], json?: unknown): Promise<SseServer> {
  const requests: ServedRequest[] = [];
  let next = 0;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = request.url ?? "";
      if (request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        return void response.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
      }
      const parsed = await body(request);
      requests.push({ url, body: parsed });
      const script = scripts[Math.min(next, scripts.length - 1)];
      next += 1;
      if (script === undefined) return void response.end();
      if (parsed.stream !== true && json !== undefined) {
        response.writeHead(200, { "content-type": "application/json" });
        return void response.end(JSON.stringify(json));
      }
      await play(script, response);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server has no port");
  const { port } = address;
  const send: ProviderFetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    return fetch(`http://127.0.0.1:${String(port)}${url.pathname}`, init);
  };
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    send,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
