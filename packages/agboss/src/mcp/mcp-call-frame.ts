import { createHash, randomUUID } from "node:crypto";
import { appWorkflowOf } from "../app/app-workflow.js";
import type { AnyTenantApp } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { standaloneCallFrameOf } from "../flow/context/call-frame.js";
import { runInFrame } from "../flow/context/frame.js";
import { outboundChainOf } from "../mesh/inbound-mesh.js";
import type { McpCall } from "./mcp-service-helpers.js";

/** An exported tool as one call over MCP sees it: its app, its class and its `name`. */
export interface ExportedToolCall {
  readonly app: AnyTenantApp;
  readonly type: Class;
  readonly name: string;
}

/**
 * Runs one MCP call of an exported tool in its own frame (#280; what `deps: [ExecutionContext]`
 * reads): the call id is the client's `_meta.callId` (else a new one). The frame runs for the
 * session's tenant and owner, and the execution id (so `step.idempotencyKey`) is scoped by tenant,
 * caller, tool and `callId`: the same caller repeating a call gets the same key, and no other
 * tenant or caller can reach it by choosing the same `callId`.
 */
export function inMcpCallFrame<TResult>(
  { app, type, name }: ExportedToolCall,
  call: McpCall,
  work: () => Promise<TResult>,
): Promise<TResult> {
  const known = appWorkflowOf(app);
  if (known === undefined) return work();
  const { workflow } = known;
  const { tenant, execution } = known.contextsOf({
    tenant: call.session.tenant,
    execution: call.session.execution,
  });
  const callId = call.callId ?? `mcp_${name}_${randomUUID()}`;
  const { ownerId, peer } = call.session;
  const executionId = scopedExecutionId({ tenantId: tenant.tenantId, ownerId, peer, name, callId });
  // the tool is this application's entry of the call chain (#398): its own calls carry it on
  const entry = { application: tenant.application.name, start: name };
  const frame = standaloneCallFrameOf({
    workflow,
    type,
    name,
    executionId,
    callId,
    signal: call.signal,
    ownerId: call.session.ownerId,
    values: execution,
    tenant,
    mesh: outboundChainOf(entry, executionId, call.mesh),
  });
  return runInFrame(frame, work);
}

/**
 * `mcp_` + a hash of (tenant, owner, peer, tool, callId), each in a slot of its own (an owner named
 * like a peer is not that peer): a client cannot pick another's id.
 */
function scopedExecutionId(parts: {
  readonly tenantId: string;
  readonly ownerId: string | undefined;
  readonly peer: string | undefined;
  readonly name: string;
  readonly callId: string;
}): string {
  const { tenantId, ownerId, peer, name, callId } = parts;
  const digest = createHash("sha256")
    .update(JSON.stringify([tenantId, ownerId ?? null, peer ?? null, name, callId]))
    .digest("hex");
  return `mcp_${digest.slice(0, 32)}`;
}
