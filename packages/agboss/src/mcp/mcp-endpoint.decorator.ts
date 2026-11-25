import { recordOptionKeys } from "../components/option-keys.js";
import { MCP_ENDPOINT_KEYS } from "../components/decorator-options.js";
import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";

export interface McpEndpointOptions {
  readonly name: string;
  readonly version: string;
  /** What the contract says of the server to a client. */
  readonly description?: string;
  readonly tools: readonly Class[];
}

/**
 * `@McpEndpoint` — what a workflow exposes as an MCP server (its name, version and exported tools).
 * Put it on an empty class and pass it to `connectMcp` / `connectMcpStdio` / `mcpHttpListener` to serve the app over
 * stdio, any transport or HTTP. Not to be confused with `@McpServer`, an MCP server the workflow *uses* (#195).
 */
export function McpEndpoint(options: McpEndpointOptions) {
  return <C extends Class>(target: C): C => {
    recordOptionKeys(target, "McpEndpoint", options, MCP_ENDPOINT_KEYS);
    recordComponent(target, { kind: "mcp-endpoint", meta: options });
    return target;
  };
}
