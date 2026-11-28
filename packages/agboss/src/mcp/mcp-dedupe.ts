import { createHash, randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AnyTenantApp } from "../app/types.js";
import { stableJson } from "../turns/index.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";
import { keyTextRuleOf } from "../core/errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import {
  MESH_REQUEST_LEASE_MS,
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
 * `MeshRequestRepository` by `(tenant, owner, peer, callId)` (A2A deduplicates by `messageId` in its task and
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
  /** The caller's own owner (before any session's), when it has one (#1410 L4). */
  readonly ownerId?: string | undefined;
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
  return {
    tenantId,
    peer: call.peer,
    idempotencyKey: idempotencyKeyOf(call.peer, call.ownerId, call.callId),
  };
};

/**
 * The call id as the store's key (#1410 L4): itself for a peer's own call (its owner is `mesh:<peer>`),
 * else `o:` + a hash of (owner, call id), so two owners of one peer and tenant never share a slot.
 * A call id that starts with `o:` is hashed too (owner none), so none can name another's key.
 */
const idempotencyKeyOf = (peer: string, ownerId: string | undefined, callId: string): string => {
  const own = ownerId === undefined || ownerId === `mesh:${peer}`;
  if (own && !callId.startsWith("o:")) return callId;
  const digest = createHash("sha256")
    .update(JSON.stringify([own ? null : ownerId, callId]))
    .digest("hex");
  return `o:${digest}`;
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
  const attemptId = randomUUID();
  const leaseFrom = (at: Date): string =>
    new Date(at.getTime() + MESH_REQUEST_LEASE_MS).toISOString();
  const record = {
    ...key,
    tool: call.tool,
    requestHash: requestHashOf(call),
    attemptId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + settings.idempotencyRetention).toISOString(),
    lockedUntil: leaseFrom(now),
  };
  if (!(await requests.saveIfAbsent(record))) {
    const kept = await requests.findByKey(key);
    // a key that is another call's is never answered with that call's result (the hash holds the tool too)
    if (kept !== undefined && kept.requestHash !== record.requestHash)
      return refusal(MeshRefusalCode.IdempotencyKeyReused);
    return kept?.response === undefined
      ? refusal(MeshRefusalCode.RequestInProgress)
      : (kept.response as CallToolResult);
  }
  // the handler holds the request while it runs: it renews its lease until it ends, and one that
  // dies stops renewing, so the request can be taken over after the lease lapses, never before
  const ended = new AbortController();
  const renewing = renewalOf(requests, key, attemptId, settings.clock, ended.signal, leaseFrom);
  try {
    const result = await run();
    ended.abort();
    await renewing;
    // fenced (false): a newer attempt owns the request now, and this late answer writes nothing
    await requests.saveResponse(key, attemptId, result);
    return result;
  } catch (error) {
    ended.abort();
    await renewing;
    await requests.deleteByKey(key, attemptId);
    throw error;
  }
}

/** Renews the lease of `attemptId` every third of it until `ended`, or until it is fenced. */
async function renewalOf(
  requests: MeshRequestRepository,
  key: MeshRequestKey,
  attemptId: string,
  clock: Clock,
  ended: AbortSignal,
  leaseFrom: (at: Date) => string,
): Promise<void> {
  const isOver = (): boolean => ended.aborted;
  while (!isOver()) {
    try {
      await clock.sleep((MESH_REQUEST_LEASE_MS / 3) as Milliseconds, ended);
    } catch {
      return;
    }
    if (isOver()) return;
    try {
      if (!(await requests.renewLease(key, attemptId, leaseFrom(clock.now())))) return;
    } catch {
      // the store did not answer: the next look renews again, the lease only lapses if none does
    }
  }
}
