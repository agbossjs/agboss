import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { App } from "../app/types.js";
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
 * `MeshRequestRepository` by `(tenant, peer, callId)` — as `POST /execute` over A2A is by the
 * envelope's idempotency key. A repeat gets the kept result without running again, one while the
 * first still runs an error result with `_meta["agboss.dev/error"]` `mesh.request-in-progress`; a
 * call that threw is forgotten, so the caller may try again. Untrusted calls, and calls without a
 * `callId`, are never deduplicated.
 */

/** What a trusted call is deduplicated by: its peer, the session's tenant and the call id. */
export interface McpDedupeCall {
  readonly peer: string | undefined;
  readonly callId: string | undefined;
  readonly tenantId: string | undefined;
}

const inProgress = (): CallToolResult => {
  const code = MeshRefusalCode.RequestInProgress;
  const error = MESH_REFUSAL_TEXT[code];
  return { ...errorResult(error), _meta: { [MESH_ERROR_META_KEY]: { code, error } } };
};

const keyOf = (call: McpDedupeCall): MeshRequestKey | undefined =>
  call.peer === undefined || call.callId === undefined
    ? undefined
    : {
        tenantId: call.tenantId ?? DEFAULT_TENANT_ID,
        peer: call.peer,
        idempotencyKey: call.callId,
      };

/** Runs `run` once per trusted call key: a repeat answered from the store. */
export async function dedupedMcpCall(
  app: App,
  call: McpDedupeCall,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const key = keyOf(call);
  const settings = meshSettingsOf(app);
  if (key === undefined || settings === undefined) return run();
  const requests = app.resolve(MeshRequestRepository);
  const createdAt = settings.clock.now().toISOString();
  if (!(await requests.saveIfAbsent({ ...key, createdAt }))) {
    const kept = await requests.findByKey(key);
    return kept?.response === undefined ? inProgress() : (kept.response as CallToolResult);
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
