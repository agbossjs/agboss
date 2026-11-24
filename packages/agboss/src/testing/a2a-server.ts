import type { A2AHttpListenerOptions } from "../a2a/a2a-http.js";
import { withLoopbackServers } from "./loopback-servers.js";
import type { TestApp } from "./test-app.js";
import { lazyLoad } from "../infrastructure/clock.js";

/** The test's A2A server (`a2aServer(options)`): its agent's URL. */
export interface A2ATestServer {
  /** `http://127.0.0.1:<port><base>`: the JSON-RPC endpoint, its card at `<url>/.well-known/agent-card.json`. */
  readonly url: string;
}

/**
 * `a2aServer({ endpoint, authenticator, base?, … })`: the listener of the test's app, on a free port
 * — its `publicUrl` that port's, unless given.
 */
export type A2AServerFixture = (
  options: Omit<A2AHttpListenerOptions, "publicUrl"> & {
    readonly publicUrl?: string | (() => string);
  },
) => Promise<A2ATestServer>;

/**
 * The `a2aServer` fixture (#387): `a2aHttpListener(app, options)` on `127.0.0.1:0` — the app built
 * first, its authenticator taken from its container — the loopback reachable for the test while it
 * runs, every server closed when the test ends. The listener's module loads on first use.
 */
export async function withA2ATestServers(
  app: TestApp,
  use: (fixture: A2AServerFixture) => Promise<void>,
): Promise<void> {
  await withLoopbackServers(app, async (start) => {
    await use(async (options) => {
      const { a2aHttpListener } = await lazyLoad(import("../a2a/a2a-http.js"));
      const origin = await start((own) =>
        a2aHttpListener(app, { ...options, publicUrl: options.publicUrl ?? own }),
      );
      return { url: `${origin}${options.base ?? ""}` };
    });
  });
}
