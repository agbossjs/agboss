import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InboundMesh } from "../mesh/inbound-mesh.js";
import { inboundMeshOfRequest, meshRefusalOf } from "../mesh/mesh-admission.js";
import { MESH_META_KEY, TRACEPARENT } from "../mesh/mesh-envelope.js";
import { meshEnvelopeOf } from "../mesh/mesh-envelope-codec.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import { failureResult, isRecord } from "./mcp-service-helpers.js";

/**
 * An MCP server's mesh check (#398 PR 1), before a `tools/call` runs: `_meta["agboss.dev/mesh"]` is
 * the caller's envelope — a claim, read but not verified (a malformed one is ignored). A chain that
 * already passed through this application's tool (a workflow start, or an exported tool), or is as
 * long as its `maxMeshHops`, is refused with an error result carrying the limit in
 * `_meta["agboss.dev/error"]`; nothing runs.
 */

/** What the check decided: the chain to run with, or the refusal to answer. */
export type McpMeshAdmission =
  | { readonly isAdmitted: true; readonly inbound?: InboundMesh }
  | { readonly isAdmitted: false; readonly refusal: CallToolResult };

/** Checks one call of `tool` (its name: the entry's `start`) of `app`. */
export function admitMcpCall(app: object, tool: string, meta: unknown): McpMeshAdmission {
  const fields = isRecord(meta) ? meta : {};
  const envelope = meshEnvelopeOf(fields[MESH_META_KEY]);
  const settings = meshSettingsOf(app);
  if (settings !== undefined) {
    const entry = { application: settings.application, start: tool };
    const limit = meshRefusalOf({ entry, maxMeshHops: settings.maxMeshHops }, envelope);
    if (limit !== undefined) return { isAdmitted: false, refusal: failureResult(limit) };
  }
  const inbound = inboundMeshOfRequest(envelope, fields[TRACEPARENT]);
  return inbound === undefined ? { isAdmitted: true } : { isAdmitted: true, inbound };
}
