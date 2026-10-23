import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { jsonSchemaOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import type { McpExposeOptions } from "./mcp-expose.decorator.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import { MESH_ERROR_META_KEY } from "../mesh/mesh-envelope.js";
import { meshLimitBodyOf } from "../mesh/mesh-wire.js";

/** Helpers for `McpService`: reading `@McpExpose` options, tool schemas, results and the resume tool. */

/** The part of the SDK's SSE server transport that `McpService` uses. */
export interface SseTransport extends Transport {
  readonly sessionId: string;
  handlePostMessage(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
}

export const createSseTransport = (endpoint: string, res: ServerResponse): SseTransport =>
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- SSE kept as the HTTP transport; migrating to StreamableHTTPServerTransport changes the wire protocol (out of scope for #180)
  new SSEServerTransport(endpoint, res);

/** One `tools/call` as the service sees it: the raw arguments, the client's cancel signal. */
export interface McpCall {
  readonly args: unknown;
  /** The client's idempotency key (`_meta.callId`), if it sent one. */
  readonly callId?: string;
  readonly signal: AbortSignal;
  /** The call chain of an admitted mesh envelope (#398, `_meta["agboss.dev/mesh"]`). */
  readonly mesh?: InboundMesh;
}

export type CallHandler = (call: McpCall) => Promise<CallToolResult>;

export interface ToolRegistry {
  readonly tools: Tool[];
  readonly handlers: Map<string, CallHandler>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The `@McpExpose` options recorded on `config`. */
export function mcpServerOptionsOf(config: Class): McpExposeOptions | undefined {
  const component = componentOf(config);
  return component?.kind === "mcp-expose" ? component.meta : undefined;
}

/** A DTO as an MCP object schema (`inputSchema` / `outputSchema`). */
export const objectSchema = (dto: DtoClass): Tool["inputSchema"] => ({
  ...jsonSchemaOf(dto),
  type: "object",
});

export const callIdOf = (meta: unknown): string | undefined =>
  isRecord(meta) && typeof meta.callId === "string" ? meta.callId : undefined;

export const RESUME_TOOL: Tool = {
  name: "resume_workflow",
  description: "Answer one pause of a paused workflow by its pause ID with the decision data.",
  inputSchema: {
    type: "object",
    properties: {
      pauseId: { type: "string", description: "The ID of the pause (pending[].pauseId)." },
      decision: {
        type: "string",
        description: "The decision/data as a JSON string to pass back to the workflow.",
      },
    },
    required: ["pauseId", "decision"],
  },
};

export function parseDecision(decision: unknown): unknown {
  if (typeof decision !== "string") return decision;
  try {
    return JSON.parse(decision) as unknown;
  } catch {
    return decision; // not JSON: pass as string
  }
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export const textOf = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

export const errorResult = (message: string): CallToolResult => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  isError: true,
});

/**
 * An error as an MCP error result; a mesh limit (#398) carries its facts in
 * `_meta["agboss.dev/error"]`, so an AGBoss client fails its step with the same limit.
 */
export function failureResult(error: unknown): CallToolResult {
  const result = errorResult(errorMessage(error));
  const mesh = meshLimitBodyOf(error);
  return mesh === undefined ? result : { ...result, _meta: { [MESH_ERROR_META_KEY]: { ...mesh } } };
}

/** Runs `work`; its value as text content, a throw as an MCP error result. */
export async function guarded(work: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: textOf(await work()) }] };
  } catch (err: unknown) {
    return failureResult(err);
  }
}
