import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

/** Where the server reads runs and listens. */
export interface EvalUiOptions {
  readonly folder: string;
  readonly port: number;
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
  let settings: EvalUiSettings = { folder: options.folder, token, port: options.port };
  const server = createServer((request, response) => {
    const answer = respondTo(
      { method: request.method ?? "GET", url: request.url ?? "/", host: request.headers.host },
      settings,
    );
    response.writeHead(answer.status, answer.headers);
    response.end(request.method === "HEAD" ? undefined : answer.body);
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
