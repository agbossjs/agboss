import type { Server } from "node:http";
import type { A2AHttpListenerOptions } from "../a2a/a2a-http.js";
import type { Class } from "../components/injection.js";
import { blockNetwork } from "./network-guard.js";
import type { TestApp } from "./test-app.js";

/** The test's A2A server (`a2aServer(options)`): its base URL — `new A2AClient({ url })`. */
export interface A2ATestServer {
  /** `http://127.0.0.1:<port><base>`: the client posts to `<url>/execute`, `<url>/resume`. */
  readonly url: string;
}

/** `a2aServer({ expose, callerResolver, base? })`: the listener of the test's app, on a free port. */
export type A2AServerFixture = <TStart extends Class>(
  options: A2AHttpListenerOptions<TStart>,
) => Promise<A2ATestServer>;

/** The servers one test started, closed at its end. */
interface A2ATestServers {
  readonly start: A2AServerFixture;
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
 * The `a2aServer` fixture (#387): `a2aHttpListener(app, options)` on `127.0.0.1:0` — the app built
 * first, its resolver taken from its container — the loopback reachable for the test while it runs
 * (`allowNetwork` implied), every server closed when the test ends. The listener's module loads on
 * first use.
 */
function a2aTestServersOf(app: TestApp): A2ATestServers {
  const servers: Server[] = [];
  let unblock: (() => void) | undefined;
  const start: A2AServerFixture = async (options) => {
    await app.ready();
    const [{ createServer }, { a2aHttpListener }] = await Promise.all([
      import("node:http"),
      import("../a2a/a2a-http.js"),
    ]);
    const server = createServer(a2aHttpListener(app, options));
    servers.push(server);
    // the test's own blocker reports a blocked host; this one only opens the loopback
    unblock ??= blockNetwork({ allowed: [LOOPBACK], onBlocked: () => undefined });
    const port = await listen(server);
    return { url: `http://${LOOPBACK}:${String(port)}${options.base ?? ""}` };
  };
  const closeAll = async (): Promise<void> => {
    await Promise.all(servers.map(close));
    unblock?.();
  };
  return { start, closeAll };
}

/** The fixture's lifetime: the test uses it, then every server it started is closed. */
export async function withA2ATestServers(
  app: TestApp,
  use: (fixture: A2AServerFixture) => Promise<void>,
): Promise<void> {
  const servers = a2aTestServersOf(app);
  try {
    await use(servers.start);
  } finally {
    await servers.closeAll();
  }
}
