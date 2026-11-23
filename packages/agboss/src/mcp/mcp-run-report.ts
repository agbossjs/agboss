import type { ExecutionOutput } from "../app/types.js";
import { definedOf } from "../infrastructure/clock.js";
import { MESH_REPORT_META_KEY } from "../mesh/mesh-envelope.js";
import { encodeRunReport } from "../mesh/mesh-report.js";
import { meshSettingsOf } from "../mesh/mesh-settings.js";
import type { McpCall } from "./mcp-service-helpers.js";

/**
 * The run report of a trusted MCP call (#398 PR 2): `_meta["agboss.dev/report"]`, signed with the
 * application's `mesh.signingKey` — what the execution spent and its id, bound to the call's
 * `bodyHash`. None for an untrusted call or an application that signs nothing.
 */
export function runReportMetaOf(
  app: object,
  call: McpCall,
  result: ExecutionOutput,
): Record<string, string> | undefined {
  const settings = meshSettingsOf(app);
  const key = settings?.keys.signingKey;
  if (key === undefined || call.bodyHash === undefined) return undefined;
  // a key is a settings' key: its settings are there
  const { application, clock } = definedOf(
    settings,
    // Stryker disable next-line StringLiteral: the invariant's text, never read while it holds
    "a signing key belongs to the settings that hold it",
  );
  const facts = {
    issuer: application,
    executionId: result.executionId,
    spentUsd: result.spend.totalUsd,
    bodyHash: call.bodyHash,
    issuedAt: clock.now(),
  };
  return { [MESH_REPORT_META_KEY]: encodeRunReport(facts, key) };
}
