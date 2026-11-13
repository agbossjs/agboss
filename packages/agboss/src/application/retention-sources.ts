import type { Infrastructure } from "../infrastructure/contracts.js";
import type { RetentionSources } from "../infrastructure/retention-sweep.js";
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
  fencedEffectRetention: assembled.fencedEffects.retention,
  auditLog: infrastructure.auditLog,
  auditLogRetention: assembled.auditLogRetention,
  expiries: a2aExpiriesOf(infrastructure, assembled),
  outboundCalls: infrastructure.outboundCalls,
  outboundCallRetention: assembled.outboundCalls.retention,
  ledger: infrastructure.costLedger,
  ledgerEntryRetention: assembled.ledgerEntryRetention,
});
