import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import { inboundMeshOfRequest, meshRefusalOf } from "../mesh/mesh-admission.js";
import { MESH_ERROR_META_KEY, MESH_META_KEY, TRACEPARENT } from "../mesh/mesh-envelope.js";
import { readMeshEnvelope, type ReadEnvelope } from "../mesh/mesh-envelope-codec.js";
import { meshSettingsOf, type MeshSettings } from "../mesh/mesh-settings.js";
import {
  MESH_REFUSAL_TEXT,
  MeshRefusalCode,
  signatureRefusalOf,
} from "../mesh/mesh-verification.js";
import { bodyHashOf } from "../mesh/outbound-mesh.js";
import { errorResult, failureResult, isRecord } from "./mcp-service-helpers.js";

/**
 * An MCP server's mesh check (#398), before a `tools/call` runs: `_meta["agboss.dev/mesh"]` is the
 * caller's envelope — a claim (a malformed one is ignored). A chain that already passed through
 * this application's tool (a workflow start, or an exported tool), or is as long as its
 * `maxMeshHops`, is refused with an error result carrying the limit in `_meta["agboss.dev/error"]`;
 * nothing runs. A signed envelope of a known peer is verified (PR 2: signature, replay window, the
 * arguments' `bodyHash`) — a bad one refused — and trusted when the session's `peer` is its issuer.
 */

/** What the check decided: the chain to run with (trusted or not), or the refusal to answer. */
export type McpMeshAdmission =
  | { readonly isAdmitted: true; readonly inbound?: InboundMesh; readonly bodyHash?: string }
  | { readonly isAdmitted: false; readonly refusal: CallToolResult };

/** One `tools/call` as the check reads it: its tool, `_meta`, arguments and the session's peer. */
export interface McpMeshCall {
  readonly tool: string;
  readonly meta: unknown;
  readonly args: unknown;
  readonly peer: string | undefined;
}

const refused = (code: MeshRefusalCode): McpMeshAdmission => {
  const error = MESH_REFUSAL_TEXT[code];
  return {
    isAdmitted: false,
    refusal: { ...errorResult(error), _meta: { [MESH_ERROR_META_KEY]: { code, error } } },
  };
};

/** Why a signed envelope of a known peer is refused; `undefined` when it holds or is not signed. */
function signedRefusalOf(
  settings: MeshSettings | undefined,
  read: ReadEnvelope | undefined,
  args: unknown,
): MeshRefusalCode | undefined {
  if (settings === undefined || read === undefined) return undefined;
  const key = read.signed === undefined ? undefined : settings.keys.peers.get(read.envelope.issuer);
  if (key === undefined) return undefined;
  const refusal = signatureRefusalOf(read, key, settings.clock.now());
  if (refusal !== undefined) return refusal;
  const isBody = read.envelope.bodyHash === bodyHashOf(JSON.stringify(args ?? {}));
  return isBody ? undefined : MeshRefusalCode.BodyMismatch;
}

/** The chain limit a call meets at `app`; `undefined` when it may run. */
function limitRefusalOf(
  settings: MeshSettings | undefined,
  tool: string,
  read: ReadEnvelope | undefined,
): McpMeshAdmission | undefined {
  if (settings === undefined) return undefined;
  const entry = { application: settings.application, start: tool };
  const limit = meshRefusalOf({ entry, maxMeshHops: settings.maxMeshHops }, read?.envelope);
  return limit === undefined ? undefined : { isAdmitted: false, refusal: failureResult(limit) };
}

/** The session's peer when the envelope carries its verified signature; else `undefined`. */
function trustedPeerOf(
  settings: MeshSettings | undefined,
  read: ReadEnvelope | undefined,
  peer: string | undefined,
): string | undefined {
  if (peer === undefined || read?.signed === undefined || read.envelope.issuer !== peer)
    return undefined;
  return settings?.keys.peers.has(peer) === true ? peer : undefined;
}

/** Checks one call of `call.tool` (the entry's `start`) of `app`. */
export function admitMcpCall(app: object, call: McpMeshCall): McpMeshAdmission {
  const fields = isRecord(call.meta) ? call.meta : {};
  const read = readMeshEnvelope(fields[MESH_META_KEY]);
  const settings = meshSettingsOf(app);
  const limited = limitRefusalOf(settings, call.tool, read);
  if (limited !== undefined) return limited;
  const refusal = signedRefusalOf(settings, read, call.args);
  if (refusal !== undefined) return refused(refusal);
  const peer = trustedPeerOf(settings, read, call.peer);
  const inbound = inboundMeshOfRequest(read?.envelope, fields[TRACEPARENT], peer);
  if (inbound === undefined) return { isAdmitted: true };
  const bodyHash = peer === undefined ? undefined : read?.envelope.bodyHash;
  return bodyHash === undefined
    ? { isAdmitted: true, inbound }
    : { isAdmitted: true, inbound, bodyHash };
}
