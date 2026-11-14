import type { Clock } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseRecipients, PauseRecord } from "../infrastructure/pause-record.js";

/**
 * The reminder look of the pause timers (#942): every tick, the pending pauses whose reminder is
 * due (every tenant, the earliest first, a page of `REMINDER_PAGE`) of the trees of this
 * instance's workflows are reminded — `remindByTenantIdAndPauseId` writes `expiring` to the
 * channel's and the listeners' mailboxes and clears `remindAt` in one transaction, so any number
 * of instances looking at one tick remind once. No lease, no tree move: nothing of the run changes.
 * A tree whose root has no record of this instance's workflows is another application's on a
 * shared store: left alone. A pause that fails is told and the others go on.
 */

/** How many due reminders one look reads. */
export const REMINDER_PAGE = 50;

/** What the look reads and writes. */
export interface ReminderSources {
  readonly pauses: Pick<
    PausedExecutionRepository,
    "findPendingByRemindAtBefore" | "remindByTenantIdAndPauseId"
  >;
  /** The roots' records: the workflow a tree belongs to. */
  readonly records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">;
  /** The names of this instance's workflows: a root's record names one of them (`bundle`). */
  readonly bundles: ReadonlySet<string>;
  /** Who is told of a pause's reminder (the pause seam's `recipientsOf`, by the pause's channel). */
  readonly recipientsOf: (pause: PauseRecord) => PauseRecipients;
  /** The notices written: looked for at once instead of at the next tick. */
  readonly delivered: () => void;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  /** Aborted by the instance's stop: the look ends between two pauses. */
  readonly signal: AbortSignal;
}

/** Whether a pause belongs to a tree of this instance's workflows. */
async function isOurs(sources: ReminderSources, pause: PauseRecord): Promise<boolean> {
  const record = await sources.records.findByTenantIdAndRunId(
    pause.tenantId,
    pause.rootExecutionId,
  );
  return record !== undefined && sources.bundles.has(record.bundle);
}

/** One look: a page of due reminders, each written once. */
export async function lookForReminders(sources: ReminderSources): Promise<void> {
  const { pauses, clock, log, signal } = sources;
  const isStopped = (): boolean => signal.aborted;
  const now = clock.now();
  const due = await pauses.findPendingByRemindAtBefore(now, REMINDER_PAGE);
  let isWritten = false;
  for (const pause of due) {
    if (isStopped()) break;
    try {
      if (!(await isOurs(sources, pause))) continue;
      const recipients = sources.recipientsOf(pause);
      const done = await pauses.remindByTenantIdAndPauseId(
        pause.tenantId,
        pause.pauseId,
        now,
        recipients,
      );
      isWritten ||= done;
    } catch (error) {
      // a stop cut it: the reminder stays due for the next instance's look
      if (isStopped()) break;
      const text = `the reminder of a pause of execution ${pause.rootExecutionId} failed: ${String(error)}`;
      log.warn("pause.reminder-failed", text, {
        tenantId: pause.tenantId,
        executionId: pause.rootExecutionId,
      });
    }
  }
  if (isWritten) sources.delivered();
}

/** The reminder look as a look of the pause timers (`pause-timers.ts`): its name, and one look. */
export const reminderLookOf = (
  infrastructure: Pick<Infrastructure, "pausedExecutions" | "records" | "clock">,
  log: FrameworkLog,
  notices: Pick<ReminderSources, "bundles" | "recipientsOf" | "delivered">,
  signal: AbortSignal,
): { readonly name: string; readonly run: () => Promise<void> } => ({
  name: "reminders",
  run: () =>
    lookForReminders({
      pauses: infrastructure.pausedExecutions,
      records: infrastructure.records,
      clock: infrastructure.clock,
      ...notices,
      log,
      signal,
    }),
});
