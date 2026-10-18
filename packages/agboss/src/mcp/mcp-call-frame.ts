import { randomUUID } from "node:crypto";
import { appWorkflowOf } from "../app/app-workflow.js";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { standaloneCallFrameOf } from "../flow/context/call-frame.js";
import { runInFrame } from "../flow/context/frame.js";
import type { McpCall } from "./mcp-service-helpers.js";

/** An exported tool as one call over MCP sees it: its app, its class and its `name`. */
export interface ExportedToolCall {
  readonly app: App;
  readonly type: Class;
  readonly name: string;
}

/**
 * Runs one MCP call of an exported tool in its own frame (#280; what `deps: [ExecutionContext]`
 * reads): the call id is the client's `_meta.callId` (else a new one), and the execution id follows
 * it, so a client repeating a call with the same `callId` gets the same `step.idempotencyKey`.
 */
export function inMcpCallFrame<TResult>(
  { app, type, name }: ExportedToolCall,
  call: McpCall,
  work: () => Promise<TResult>,
): Promise<TResult> {
  const known = appWorkflowOf(app);
  if (known === undefined) return work();
  const { workflow, tenant } = known;
  const callId = call.callId ?? `mcp_${name}_${randomUUID()}`;
  const executionId = `mcp_${callId}`;
  const frame = standaloneCallFrameOf({
    workflow,
    type,
    name,
    executionId,
    callId,
    signal: call.signal,
    tenant,
  });
  return runInFrame(frame, work);
}
