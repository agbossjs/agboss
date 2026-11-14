import type { ExpireRoot } from "../app/expire-root.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";

/**
 * The expiry look of the pause timers (#941): every tick, the pending pauses whose deadline passed
 * (every tenant, the earliest first, a page of `EXPIRY_PAGE`) are grouped by their tree's root, and
 * each root's workflow — found through the root's record, as the orphan look does — expires them
 * under the tree's lease. A root another instance holds is skipped (its holder's drain or a later
 * look does it, I5); a root that fails is told and the others go on.
 */

/** How many due pauses one look reads. */
export const EXPIRY_PAGE = 50;

/** What the look reads and moves. */
export interface ExpirySources {
  readonly pauses: Pick<PausedExecutionRepository, "findPendingByExpiresAtBefore">;
  /** The roots' records: the one a tree's root wrote names the workflow that moves it. */
  readonly records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">;
  /** Each workflow's expiry of one of its roots, by the bundle its records name. */
  readonly expiries: ReadonlyMap<string, ExpireRoot>;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  /** Aborted by the instance's stop: the look ends between two roots. */
  readonly signal: AbortSignal;
}

/** One look: a page of due pauses, each of their roots expired once. */
export async function lookForExpiredPauses(sources: ExpirySources): Promise<void> {
  const { pauses, records, expiries, clock, log, signal } = sources;
  const due = await pauses.findPendingByExpiresAtBefore(clock.now(), EXPIRY_PAGE);
  const roots = new Map(due.map((pause) => [`${pause.tenantId}\0${pause.rootExecutionId}`, pause]));
  const isStopped = (): boolean => signal.aborted;
  for (const { tenantId, rootExecutionId } of roots.values()) {
    if (isStopped()) return;
    try {
      // a root with no record (another application's tree on a shared store) is skipped
      const record = await records.findByTenantIdAndRunId(tenantId, rootExecutionId);
      if (record !== undefined) await expiries.get(record.bundle)?.(record, signal);
    } catch (error) {
      // a stop cut it: the pause stays pending for the next instance's look
      if (isStopped()) return;
      const text = `the expiry of execution ${rootExecutionId} failed: ${String(error)}`;
      log.warn("pause.expiry-failed", text, { tenantId, executionId: rootExecutionId });
    }
  }
}

/** One workflow of the instance, as the expiry look needs it: its name and its expiry of a root. */
export interface ExpiringWorkflow {
  readonly deps: { readonly config: { readonly name: string } };
  readonly expire: ExpireRoot;
}

/** The expiry look as a look of the pause timers (`pause-timers.ts`): its name, and one look. */
export const expiryLookOf = (
  infrastructure: Pick<Infrastructure, "pausedExecutions" | "records" | "clock">,
  log: FrameworkLog,
  workflows: readonly ExpiringWorkflow[],
  signal: AbortSignal,
): { readonly name: string; readonly run: () => Promise<void> } => ({
  name: "expiry",
  run: () =>
    lookForExpiredPauses({
      pauses: infrastructure.pausedExecutions,
      records: infrastructure.records,
      expiries: new Map(workflows.map((one) => [one.deps.config.name, one.expire])),
      clock: infrastructure.clock,
      log,
      signal,
    }),
});
