import type { McpHttpListenerOptions } from "../mcp/mcp-http-listener.js";
import { withLoopbackServers } from "./loopback-servers.js";
import type { TestApp } from "./test-app.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";

/** The test's MCP server (`mcpServer(endpoint, options)`): its URL. */
export interface McpTestServer {
  /** `http://127.0.0.1:<port><base>`: the Streamable HTTP endpoint an MCP client connects to. */
  readonly url: string;
}

/** What `mcpServer` takes besides the endpoint: the listener's options, `publicUrl` that of the free port unless given. */
export type McpServerFixtureOptions = Omit<McpHttpListenerOptions, "endpoint" | "publicUrl"> & {
  readonly publicUrl?: string;
};

/**
 * `mcpServer(Endpoint, { authenticator?, base?, … })` (#1328): the test's app served as an MCP server on
 * a free loopback port, symmetric with `a2aServer` — an `@McpEndpoint` of a workflow, reached by a
 * real MCP client.
 */
export type McpServerFixture = (
  endpoint: Class,
  options?: McpServerFixtureOptions,
) => Promise<McpTestServer>;

/** The `mcpServer` fixture: `mcpHttpListener(app, …)` on `127.0.0.1:0`, closed when the test ends. */
export async function withMcpTestServers(
  app: TestApp,
  use: (fixture: McpServerFixture) => Promise<void>,
): Promise<void> {
  // a built test app answers what the listener reads of an app (`resolve`, `execute`, the mesh settings it remembers)
  const served = app as unknown as App;
  await withLoopbackServers(app, async (start) => {
    await use(async (endpoint, options = {}) => {
      const { mcpHttpListener } = await lazyLoad(import("../mcp/mcp-http-listener.js"));
      const origin = await start((own) =>
        mcpHttpListener(served, { ...options, endpoint, publicUrl: options.publicUrl ?? own }),
      );
      return { url: `${origin}${options.base ?? ""}` };
    });
  });
}
