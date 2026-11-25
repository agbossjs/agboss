import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { blockNetwork } from "./network-guard.js";
import type { TestApp } from "./test-app.js";
import { lazyLoad } from "../infrastructure/clock.js";

/** A request handler a loopback server serves: an `a2aHttpListener` or an `mcpHttpListener`. */
type LoopbackHandler = (req: IncomingMessage, res: ServerResponse) => void;

/** The servers one test started, closed at its end. */
interface LoopbackServers {
  /** Starts a server on a free loopback port; `handlerOf` gets the origin it listens on. */
  readonly start: (handlerOf: (origin: string) => LoopbackHandler) => Promise<string>;
  readonly closeAll: () => Promise<void>;
}

const LOOPBACK = "127.0.0.1";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  const address = server.address();
  // listening on a TCP port: the address is an AddressInfo, never a pipe name
  return typeof address === "object" && address !== null ? address.port : 0;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

/**
 * The servers of one test (`a2aServer`, `mcpServer`): each a listener of the test's app on
 * `127.0.0.1:0`, the app built first, the loopback reachable for the test while it runs
 * (`allowNetwork` implied), every server closed when the test ends.
 */
function loopbackServersOf(app: TestApp): LoopbackServers {
  const servers: Server[] = [];
  let unblock: (() => void) | undefined;
  const start: LoopbackServers["start"] = async (handlerOf) => {
    await app.ready();
    const { createServer } = await lazyLoad(import("node:http"));
    // the port is known once it listens: the listener is built then, before its first request
    const listening: { handler?: LoopbackHandler } = {};
    const server = createServer((req, res) => {
      listening.handler?.(req, res);
    });
    servers.push(server);
    // the test's own blocker reports a blocked host; this one only opens the loopback
    unblock ??= blockNetwork({ allowed: [LOOPBACK], onBlocked: () => undefined });
    const port = await listen(server);
    const origin = `http://${LOOPBACK}:${String(port)}`;
    listening.handler = handlerOf(origin);
    return origin;
  };
  const closeAll = async (): Promise<void> => {
    await Promise.all(servers.map(close));
    unblock?.();
  };
  return { start, closeAll };
}

/** A fixture's lifetime: the test uses it, then every server it started is closed. */
export async function withLoopbackServers(
  app: TestApp,
  use: (servers: LoopbackServers["start"]) => Promise<void>,
): Promise<void> {
  const servers = loopbackServersOf(app);
  try {
    await use(servers.start);
  } finally {
    await servers.closeAll();
  }
}
