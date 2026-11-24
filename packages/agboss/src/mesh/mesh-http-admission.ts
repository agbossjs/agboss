import type { Class } from "../components/injection.js";
import { verifyMeshHttp, type ReceivedHttp, type VerifiedMeshHttp } from "./mesh-http.js";
import type { MeshSettings } from "./mesh-settings.js";
import { MeshInboundMode } from "./mesh.decorator.js";
import { MeshRefusalCode } from "./mesh-verification.js";

/**
 * What a mesh endpoint decides of one received HTTP request before it reads anything else of it
 * (#1320): the request is a verified peer's (`X-AGBoss-Mesh`), an external caller's (the
 * `@HttpAuthenticator`'s to judge, only when `@Mesh({ inboundMode: AllowExternal })` or no `@Mesh`),
 * or refused — `401` for a signature that is missing, unknown or does not hold, `403` for a peer
 * that may not call this endpoint.
 */
export type MeshHttpAdmission =
  | {
      readonly kind: "peer";
      readonly peer: string;
      /** The tenant the peer signed, only when its `propagateTenant` trusts it. */
      readonly tenantId: string | undefined;
      /** The owner of what the peer starts: `mesh:<peer>`, so two peers never share a task. */
      readonly ownerId: string;
    }
  | { readonly kind: "external" }
  | { readonly kind: "refused"; readonly status: 401 | 403 | 503; readonly code: MeshRefusalCode };

/** The owner id of a verified peer's tasks. */
export const meshOwnerOf = (peer: string): string => `mesh:${peer}`;

const refused = (status: 401 | 403 | 503, code: MeshRefusalCode): MeshHttpAdmission => ({
  kind: "refused",
  status,
  code,
});

/** Whether a peer may call `endpoint`: it lists none (any), or lists it. */
const mayCall = (allowed: readonly Class[] | undefined, endpoint: Class | undefined): boolean =>
  allowed === undefined ||
  allowed.length === 0 ||
  (endpoint !== undefined && allowed.includes(endpoint));

/** The tenant under which the signed requests already admitted are remembered. */
const REPLAY_TENANT = "mesh-http";

/**
 * Remembers `(peer, jti)` in the application's shared `MeshRequestRepository` — kept at least as long
 * as a signature can be replayed (`deduplicationTtl` is validated above `envelopeTtl + maxClockSkew`).
 * A request seen before is `mesh.replayed`; a store that fails answers nothing and nothing is
 * admitted (fail closed). Only a request whose signature already held reaches here: an attacker cannot
 * fill the store with ids of its own.
 */
async function firstSeen(
  settings: MeshSettings,
  verified: VerifiedMeshHttp,
): Promise<MeshHttpAdmission | undefined> {
  // the record counts its retention from the later of now and the signature's date: a signature dated
  // up to `maxClockSkew` ahead is valid that much later, and is remembered that much longer
  const kept = Math.max(settings.clock.now().getTime(), verified.issuedAt.getTime());
  try {
    const isNew = await settings.requests().saveIfAbsent({
      tenantId: REPLAY_TENANT,
      peer: verified.peer,
      idempotencyKey: verified.jti,
      createdAt: new Date(kept).toISOString(),
    });
    return isNew ? undefined : refused(401, MeshRefusalCode.Replayed);
  } catch {
    return refused(503, MeshRefusalCode.ReplayCheckUnavailable);
  }
}

/**
 * Decides one request to `endpoint` (an `@A2AEndpoint` / `@McpEndpoint` class). The header is verified
 * before anything it claims is used; a request without one is an external caller's only under
 * `AllowExternal`; a verified peer reaches `endpoint` only when its `allowEndpoints` lists it (or lists
 * none).
 */
export async function admitMeshHttp(
  settings: MeshSettings,
  received: ReceivedHttp,
  endpoint: Class | undefined,
): Promise<MeshHttpAdmission> {
  if (received.header === undefined) {
    return settings.inboundMode === MeshInboundMode.Strict
      ? refused(401, MeshRefusalCode.SignatureMissing)
      : { kind: "external" };
  }
  const verdict = verifyMeshHttp(settings, received);
  if (!verdict.isVerified) return refused(401, verdict.code);
  const fresh = await firstSeen(settings, verdict);
  if (fresh !== undefined) return fresh;
  const rules = settings.peers.get(verdict.peer);
  // a key the peer is known by but no rules: cannot happen (both come from the same `@Mesh`)
  if (rules === undefined) return refused(401, MeshRefusalCode.PeerUnknown);
  if (!mayCall(rules.allowEndpoints, endpoint))
    return refused(403, MeshRefusalCode.EndpointForbidden);
  return {
    kind: "peer",
    peer: verdict.peer,
    tenantId: rules.propagateTenant ? verdict.tenantId : undefined,
    ownerId: meshOwnerOf(verdict.peer),
  };
}
