import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { textResponse, type EvalUiResponse } from "./ui-responses.js";
import { respondTo, type EvalUiSettings } from "./ui-routes.js";

/**
 * The server of `agboss eval ui` (#397 PR 3): `node:http` on the loopback address only, a fresh
 * 128-bit token per start, every answer from `respondTo`. Port 0 takes a free port.
 */

/** A running eval UI: where to open it, and how to stop it. */
export interface EvalUi {
  /** The URL to open, its token included. */
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** Where the server reads runs and labels, and listens. */
export type EvalUiOptions = Omit<EvalUiSettings, "token">;

/** The largest form a POST may send. */
const MAX_BODY_BYTES = 64 * 1024;

/** A request's body, up to the bound; undefined when it is larger. */
function bodyOf(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(size > MAX_BODY_BYTES ? undefined : Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

async function answerOf(
  request: IncomingMessage,
  settings: EvalUiSettings,
): Promise<EvalUiResponse> {
  const body = request.method === "POST" ? await bodyOf(request) : "";
  if (body === undefined) return textResponse(413, "a form of agboss eval ui is at most 64 KB");
  return await respondTo(
    {
      method: request.method ?? "GET",
      url: request.url ?? "/",
      host: request.headers.host,
      origin: request.headers.origin,
      body,
    },
    settings,
  );
}

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

/** Starts the server; resolves once it listens. */
export async function startEvalUi(options: EvalUiOptions): Promise<EvalUi> {
  const token = randomBytes(16).toString("hex");
  let settings: EvalUiSettings = { ...options, token };
  const server = createServer((request, response) => {
    void answerOf(request, settings).then(
      (answer) => {
        response.writeHead(answer.status, answer.headers);
        response.end(request.method === "HEAD" ? undefined : answer.body);
      },
      (error: unknown) => {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(
          `agboss eval ui failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  });
  const port = await listen(server, options.port);
  settings = { ...settings, port };
  return {
    url: `http://127.0.0.1:${String(port)}/?token=${token}`,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
