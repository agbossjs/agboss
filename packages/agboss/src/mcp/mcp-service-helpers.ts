import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ExecutionOptions } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import { jsonSchemaOf } from "../dto/schema.js";
import type { DtoClass } from "../dto/types.js";
import type { McpEndpointOptions } from "./mcp-endpoint.decorator.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import { MESH_ERROR_META_KEY } from "../mesh/mesh-envelope.js";
import { RecordedError } from "../core/error-record.js";
import { meshLimitBodyOf } from "../mesh/mesh-wire.js";

/** Helpers for the MCP server: reading `@McpEndpoint` options, tool schemas, results and the resume tool. */

/**
 * What every call of one MCP session runs with (#261): the thread's owner and the execution's typed
 * context values — `tenant` (a resume uses its `tenantId`) and the declared `execution` fields —
 * taken by the transport from its authenticated caller, never from the call's arguments.
 */
export type McpSessionOptions = Pick<ExecutionOptions, "ownerId" | "tenant" | "execution">;

/**
 * The caller of one MCP message as the server runs it: a session's values and, for a signed mesh
 * peer, the peer itself (#398 PR 2), by its `@Application({ name })` — when a call's envelope carries
 * its valid signature, its budget, deadline and origin are honoured and the run's report is signed
 * back (`_meta["agboss.dev/report"]`). Only the HTTP listener, after it verified the signature,
 * makes one with a `peer`: a host's `session` never names a peer.
 */
export type McpCaller = McpSessionOptions & {
  readonly peer?: string;
  /**
   * Set by the HTTP listener once the caller is in a session (`inSession`): the owner it came with,
   * none for a tenant's key; absent for an anonymous caller, whose `ownerId` is the session's own. Scopes call idempotency across sessions.
   */
  readonly authOwnerId?: string | undefined;
};

/** One `tools/call` as the service sees it: the raw arguments, the client's cancel signal. */
export interface McpCall {
  readonly args: unknown;
  /** The identity THIS call runs with (#1319b): its own message's verified caller, never a stored one. */
  readonly session: McpCaller;
  /** The client's idempotency key (`_meta.callId`), if it sent one. */
  readonly callId?: string;
  readonly signal: AbortSignal;
  /** The call chain of an admitted mesh envelope (#398, `_meta["agboss.dev/mesh"]`). */
  readonly mesh?: InboundMesh;
  /** A trusted envelope's `bodyHash` (#398 PR 2): what the run report the server signs names. */
  readonly bodyHash?: string;
}

export type CallHandler = (call: McpCall) => Promise<CallToolResult>;

export interface ToolRegistry {
  readonly tools: Tool[];
  readonly handlers: Map<string, CallHandler>;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The `@McpEndpoint` options recorded on `config`. */
export function mcpServerOptionsOf(config: Class): McpEndpointOptions | undefined {
  const component = componentOf(config);
  return component?.kind === "mcp-endpoint" ? component.meta : undefined;
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
  description:
    "Answer one pause of a paused workflow by its pause ID, with the decision data or a free-text reply (exactly one).",
  inputSchema: {
    type: "object",
    properties: {
      pauseId: { type: "string", description: "The ID of the pause (pending[].pauseId)." },
      decision: {
        type: "string",
        description: "The decision/data as a JSON string to pass back to the workflow.",
      },
      reply: {
        type: "string",
        description:
          "A free-text reply, read by the pause's channel interpreter instead of a decision.",
      },
    },
    required: ["pauseId"],
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

export const errorMessage = (err: unknown): string => {
  // a recorded error whose original was no framework error says nothing of the original (#1325)
  if (err instanceof RecordedError && !err.isFramework) return "the call failed";
  return err instanceof Error ? err.message : String(err);
};

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
