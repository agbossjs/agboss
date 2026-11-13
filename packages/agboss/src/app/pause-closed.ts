import { UnknownPauseError } from "../run/resume-agent.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { closedAtOf, pauseClosedReasonOf } from "../infrastructure/pause-closing.js";
import { PauseClosedReason, type PauseRecord } from "../infrastructure/pause-record.js";
import { PauseClosedError } from "./pause-closed-error.js";

/**
 * The refusal of an answer to a pause that is not waiting (#939): the record read now says why it
 * closed and when (a pending one past its deadline is `Expired` whatever the sweep did yet); a
 * record the retention removed meanwhile is an unknown pause.
 */
export async function pauseClosed(
  pauses: Pick<PausedExecutionRepository, "findByTenantIdAndPauseId">,
  pause: Pick<PauseRecord, "tenantId" | "pauseId">,
  at: Date,
): Promise<PauseClosedError | UnknownPauseError> {
  const { tenantId, pauseId } = pause;
  const record = await pauses.findByTenantIdAndPauseId(tenantId, pauseId);
  if (record === undefined)
    return new UnknownPauseError({ message: `tenant ${tenantId} has no pause ${pauseId}` });
  const reason = pauseClosedReasonOf(record, at);
  if (reason === undefined) {
    // refused by the store while it still reads pending: its deadline passed on the store's clock
    const closedAt = record.expiresAt ?? at.toISOString();
    return new PauseClosedError({ pauseId, tenantId, reason: PauseClosedReason.Expired, closedAt });
  }
  const closedAt = closedAtOf(record) ?? record.expiresAt ?? at.toISOString();
  return new PauseClosedError({ pauseId, tenantId, reason, closedAt });
}
