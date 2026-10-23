import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { a2aHttpListener, type A2AHttpListenerOptions } from "../../../src/a2a/index.js";
import { createApp } from "../../../src/application/create-app.js";
import type { App } from "../../../src/app/types.js";
import type { Class } from "../../../src/components/injection.js";
import type { ScriptBook } from "../../../src/testing/script-book.js";
import { offline } from "./remote.workflow.js";
import { meshAppOf, type MeshAppParts, type MeshAppSpec } from "./mesh.workflow.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** A server listening before its application exists, so two applications can name each other. */
export interface Endpoint {
  readonly url: string;
  /** Every request's headers, in order. */
  readonly headers: IncomingMessage["headers"][];
  serve(handler: Handler): void;
}

/** What a test opened: closed at its end. */
export interface Opened {
  readonly servers: Server[];
  readonly apps: App[];
}

export const opened = (): Opened => ({ servers: [], apps: [] });

export async function closeAll(open: Opened): Promise<void> {
  await Promise.all(open.apps.splice(0).map((app) => app.close()));
  await Promise.all(
    open.servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
}

export async function endpoint(open: Opened): Promise<Endpoint> {
  let current: Handler | undefined;
  const headers: IncomingMessage["headers"][] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers);
    current?.(req, res);
  });
  open.servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    headers,
    serve: (handler) => {
      current = handler;
    },
  };
}

/** What else one mesh application is started with: its process variables, a verifier. */
export interface MeshAppStart {
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly meshVerifier?: A2AHttpListenerOptions<Class>["meshVerifier"];
}

/** One mesh application, served at `own`, calling `spec.peerUrl`. */
export async function meshApp(
  open: Opened,
  own: Endpoint,
  spec: MeshAppSpec,
  book: ScriptBook,
  started: MeshAppStart = {},
): Promise<{ readonly app: App; readonly parts: MeshAppParts }> {
  const parts = meshAppOf(spec);
  const app = await createApp(parts.MeshApplication, {
    ...offline(book),
    processEnv: started.processEnv ?? {},
    ...(spec.mesh === undefined ? {} : { env: "signing" }),
  });
  open.apps.push(app);
  const verifier = started.meshVerifier === undefined ? {} : { meshVerifier: started.meshVerifier };
  own.serve(
    a2aHttpListener(app, {
      expose: parts.MeshA2AExpose,
      callerResolver: parts.Resolver,
      ...verifier,
    }),
  );
  return { app, parts };
}
