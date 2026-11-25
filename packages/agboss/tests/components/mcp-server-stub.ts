import type {
  McpServerClient,
  ServerToolCallable,
  ServerToolHandlers,
  ServerTools,
  ToolsOf,
} from "../../src/components/mcp-client.js";

/** A server instance answered by `handlers` — for testing MCP tools with `new`, no process. */
export function mcpServerStub<TServer extends McpServerClient<ServerTools>>(
  server: new () => TServer,
  handlers: ServerToolHandlers<ToolsOf<TServer>>,
): TServer {
  const instance = new server();
  const entries = Object.entries(handlers).flatMap(([name, handler]) => {
    if (handler === undefined) return [];
    // one handler per declared tool; at this boundary its argument and result are plain data
    const call = handler as (args: unknown) => Promise<unknown>;
    const callable: ServerToolCallable = {
      invoke: async (raw) => ({ kind: "ok", value: await call(raw) }),
    };
    return [[name, callable] as const];
  });
  instance.attachServerTools(new Map(entries));
  return instance;
}
