import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyTenantApp } from "../app/types.js";
import { stableJson } from "../turns/index.js";
import { keyTextRuleOf } from "../core/errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import {
  MeshRequestRepository,
  type MeshRequestKey,
} from "../infrastructure/mesh-request.repository.js";
import { MESH_ERROR_META_KEY } from "../mesh/mesh-envelope.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { MESH_REFUSAL_TEXT, MeshRefusalCode } from "../mesh/mesh-verification.js";
import { errorResult } from "./mcp-service-helpers.js";

/**
 * A trusted MCP call's idempotency (#398 PR 2b, S5): a `tools/call` whose envelope carries the
 * session peer's valid signature and a `_meta.callId` is kept in the application's
 * `MeshRequestRepository` by `(tenant, peer, callId)` (A2A deduplicates by `messageId` in its task and
 * message stores). A repeat gets the kept result without running again, one while the
 * first still runs an error result with `_meta["agboss.dev/error"]` `mesh.request-in-progress`; a
 * call that threw is forgotten, so the caller may try again. Untrusted calls, and calls without a
 * `callId`, are never deduplicated.
 */

/** What a trusted call is deduplicated by: its peer, the session's tenant and the call id. */
export interface McpDedupeCall {
  readonly tool: string;
  readonly args: unknown;
  readonly peer: string | undefined;
  readonly callId: string | undefined;
  readonly tenantId: string | undefined;
}

const refusal = (code: MeshRefusalCode): CallToolResult => {
  const error = MESH_REFUSAL_TEXT[code];
  return { ...errorResult(error), _meta: { [MESH_ERROR_META_KEY]: { code, error } } };
};

/** `sha256:<hex>` of the call's tool and arguments: what a repeat of its key must ask again. */
const requestHashOf = (call: McpDedupeCall): string =>
  `sha256:${createHash("sha256")
    .update(stableJson({ tool: call.tool, args: call.args ?? null }))
    .digest("hex")}`;

const keyOf = (call: McpDedupeCall): MeshRequestKey | undefined => {
  const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
  // #568: a tenant id that is no key's text keys no result (UTF-8 stores merge t\uD800 with
  // t\uFFFD); the call runs and its execution refuses it
  if (call.peer === undefined || call.callId === undefined || keyTextRuleOf(tenantId) !== undefined)
    return undefined;
  return { tenantId, peer: call.peer, idempotencyKey: call.callId };
};

/** Runs `run` once per trusted call key: a repeat answered from the store. */
export async function dedupedMcpCall(
  app: AnyTenantApp,
  call: McpDedupeCall,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const key = keyOf(call);
  const settings = meshSettingsOf(app);
  if (key === undefined || settings === undefined) return run();
  const requests = app.resolve(MeshRequestRepository);
  const now = settings.clock.now();
  const record = {
    ...key,
    tool: call.tool,
    requestHash: requestHashOf(call),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + settings.idempotencyRetention).toISOString(),
  };
  if (!(await requests.saveIfAbsent(record))) {
    const kept = await requests.findByKey(key);
    // a key that is another call's is never answered with that call's result
    if (
      kept !== undefined &&
      (kept.tool !== record.tool || kept.requestHash !== record.requestHash)
    )
      return refusal(MeshRefusalCode.IdempotencyKeyReused);
    return kept?.response === undefined
      ? refusal(MeshRefusalCode.RequestInProgress)
      : (kept.response as CallToolResult);
  }
  try {
    const result = await run();
    await requests.saveResponse(key, result);
    return result;
  } catch (error) {
    await requests.deleteByKey(key);
    throw error;
  }
}
