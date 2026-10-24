import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { textResponse, type EvalUiResponse } from "./ui-responses.js";
import { respondTo, type EvalUiRequest, type EvalUiSettings } from "./ui-routes.js";

/**
 * The local server of `agboss eval ui` and `agboss hub ui` (#397 PR 3, #401 PR 6) — one server for
 * both, secured once: `node:http` on the loopback address only, a fresh 128-bit token per start,
 * a form's body bounded, every answer from the command's own routes. Port 0 takes a free port.
 */

/** A running local UI: where to open it, and how to stop it. */
export interface LocalUi {
  /** The URL to open, its token included. */
  readonly url: string;
  readonly port: number;
  readonly close: () => Promise<void>;
}

/** The eval UI is one. */
export type EvalUi = LocalUi;

/** What a request says, as the routes read it. */
export type LocalUiRequest = EvalUiRequest;

/** Who the server is for its routes: its token and the port it listens on. */
export interface LocalUiServed {
  readonly token: string;
  readonly port: number;
}

/** How a local UI answers. */
export interface LocalUiOptions {
  /** The command, for its error answers (`agboss hub ui`). */
  readonly name: string;
  readonly port: number;
  readonly respond: (
    request: LocalUiRequest,
    served: LocalUiServed,
  ) => EvalUiResponse | Promise<EvalUiResponse>;
}

/** Where the eval UI reads runs and labels, and listens. */
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
  options: LocalUiOptions,
  served: LocalUiServed,
): Promise<EvalUiResponse> {
  const body = request.method === "POST" ? await bodyOf(request) : "";
  if (body === undefined) return textResponse(413, `a form of ${options.name} is at most 64 KB`);
  const asked = {
    method: request.method ?? "GET",
    url: request.url ?? "/",
    host: request.headers.host,
    origin: request.headers.origin,
    body,
  };
  return await options.respond(asked, served);
}

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

/** Starts a local UI; resolves once it listens. */
export async function startLocalUi(options: LocalUiOptions): Promise<LocalUi> {
  const token = randomBytes(16).toString("hex");
  let served: LocalUiServed = { token, port: options.port };
  const server = createServer((request, response) => {
    void answerOf(request, options, served).then(
      (answer) => {
        response.writeHead(answer.status, answer.headers);
        response.end(request.method === "HEAD" ? undefined : answer.body);
      },
      (error: unknown) => {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(
          `${options.name} failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    );
  });
  const port = await listen(server, options.port);
  served = { token, port };
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

/** Starts `agboss eval ui`'s server. */
export const startEvalUi = (options: EvalUiOptions): Promise<EvalUi> =>
  startLocalUi({
    name: "agboss eval ui",
    port: options.port,
    respond: (request, served) => respondTo(request, { ...options, ...served }),
  });
