import type { Infrastructure } from "../infrastructure/contracts.js";
import type { RetentionSources } from "../infrastructure/retention-sweep.js";
import { fileExpiryOf } from "./file-expiry.js";
import { a2aExpiriesOf } from "./a2a-expiries.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * What every look of the recovery sweep removes once its retention is over, and where a closed
 * pause's answer is logged before its record goes (#939): the application's stores and retentions.
 */
export const retentionSourcesOf = (
  infrastructure: Infrastructure,
  assembled: AssembledApplication,
): RetentionSources => ({
  clock: infrastructure.clock,
  answers: infrastructure.records,
  pauses: infrastructure.pausedExecutions,
  pauseRecordRetention: assembled.pauseRecordRetention,
  meshRequests: infrastructure.meshRequests,
  idempotencyRetention: assembled.meshAnswerRetention,
  executionHistory: infrastructure.executionHistory,
  executionRecordRetention: assembled.executionRecordRetention,
  fencedEffects: infrastructure.fencedEffects,
  auditLog: infrastructure.auditLog,
  treeRecords: infrastructure.records,
  auditLogRetention: assembled.auditLogRetention,
  expiries: [
    ...a2aExpiriesOf(infrastructure, assembled),
    fileExpiryOf({
      files: infrastructure.a2aFiles,
      clock: infrastructure.clock,
      workflows: assembled.workflows.map((workflow) => workflow.graph.type),
      isLive: async ({ tenantId, ownerId }) =>
        (await infrastructure.records.findByTenantIdAndRunId(tenantId, ownerId)) !== undefined ||
        (await infrastructure.a2aTasks.findById({ tenantId, taskId: ownerId })) !== undefined,
    }),
  ],
  outboundCalls: infrastructure.outboundCalls,
  ledger: infrastructure.costLedger,
  ledgerEntryRetention: assembled.ledgerEntryRetention,
});
