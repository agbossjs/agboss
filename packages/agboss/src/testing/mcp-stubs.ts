import type { McpConnect } from "../app/app-deps.js";
import type {
  McpServerClient,
  ServerTools,
  ServerToolHandlers,
  ToolsOf,
} from "../components/mcp-client.js";
import { connectMcpServers, type McpCaller } from "../tools/index.js";
import { LiveCallBlockedError } from "./errors.js";
import type { ScriptBook } from "./script-book.js";

/** One call a stubbed server got: the server tool and its arguments. */
export interface McpStubCall {
  readonly tool: string;
  readonly args: unknown;
}

/** A stubbed MCP server: `mcpOf(ShortlistServer).thenReturn({ read_text_file: async () => ({ … }) })`. */
export interface McpStub<TServer extends McpServerClient<ServerTools>> {
  /** Adds (or replaces) handlers per server tool. */
  thenReturn(handlers: ServerToolHandlers<ToolsOf<TServer>>): McpStub<TServer>;
  /** Every call the server got, in order. */
  readonly calls: readonly McpStubCall[];
}

type Handler = (args: unknown) => Promise<unknown>;

/** The stubs of every MCP server of one test, by server name; shared by the test's apps. */
export class McpStubs {
  readonly #handlers = new Map<string, Map<string, Handler>>();
  readonly #calls = new Map<string, McpStubCall[]>();

  constructor(private readonly book: ScriptBook) {}

  stubOf<TServer extends McpServerClient<ServerTools>>(server: string): McpStub<TServer> {
    const handlers = this.#handlers.get(server) ?? new Map<string, Handler>();
    this.#handlers.set(server, handlers);
    const calls = this.#calls.get(server) ?? [];
    this.#calls.set(server, calls);
    const stub: McpStub<TServer> = {
      thenReturn: (given) => {
        for (const [tool, handler] of Object.entries(given)) {
          // one handler per declared tool; at this boundary its argument and result are plain data
          if (handler !== undefined) handlers.set(tool, handler as Handler);
        }
        return stub;
      },
      calls,
    };
    return stub;
  }

  /** The caller a stubbed server's tools go through: its handler, or a blocked live call. */
  callerOf(server: string, label: string): McpCaller {
    return async (tool, args) => {
      this.stubOf(server);
      this.#calls.get(server)?.push({ tool, args });
      const handler = this.#handlers.get(server)?.get(tool);
      if (handler === undefined) {
        throw this.book.report(
          new LiveCallBlockedError({
            message: `MCP server "${server}" tool "${tool}" has no stub; add mcpOf(${label}).thenReturn({ ${tool}: … })`,
          }),
        );
      }
      return { structuredContent: await handler(args), content: [] };
    };
  }
}

/**
 * How a test connects MCP servers: every server is a stub, except the ones named in `real`
 * (connected through their configured transports, contract-checked as in production).
 */
export function stubbedMcpConnect(
  stubs: McpStubs,
  labels: ReadonlyMap<string, string>,
  real: ReadonlySet<string>,
): McpConnect {
  return async (bundle, config, env) => {
    const stubbed = bundle.mcpServers.filter((handle) => !real.has(handle.name));
    for (const handle of stubbed) {
      handle.bind(stubs.callerOf(handle.name, labels.get(handle.name) ?? handle.name));
    }
    const connected = await connectMcpServers(
      config.mcpServers,
      bundle.mcpServers.filter((handle) => real.has(handle.name)),
      (bundle.serverTools ?? []).filter((facade) => real.has(facade.mcp.server)),
      env,
    );
    return {
      close: async () => {
        stubbed.forEach((handle) => {
          handle.bind(undefined);
        });
        await connected.close();
      },
    };
  };
}
