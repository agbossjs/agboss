import { definedOf, type Clock } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PauseScanAfter } from "../infrastructure/pause-notices.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseRecipients, PauseRecord } from "../infrastructure/pause-record.js";
import type { TimerLook } from "./pause-timers.js";

/**
 * The reminder look of the pause timers (#942): every tick, the pending pauses whose reminder is
 * due (every tenant, the earliest first, pages of `REMINDER_PAGE`) of the trees of this instance's
 * workflows are reminded — `remindByTenantIdAndPauseId` writes `expiring` to the channel's and the
 * listeners' mailboxes and clears `remindAt` in one transaction, so any number of instances looking
 * at one tick remind once. No lease, no tree move: nothing of the run changes. A tree whose root
 * has no record of this instance's workflows is another application's on a shared store: left
 * alone. A pause that fails is told and the others go on.
 *
 * As the expiry look (#1070, #1071, #1072): a look is one sweep over the due reminders with a
 * keyset cursor, so a pause nobody here can remind (another application's) stays due and is passed —
 * never read again within the sweep — and cannot hide the reminders behind it; each reminder is
 * started, not awaited, so a slow store never stalls the timer loop, with at most `REMINDER_PAGE` in
 * flight (a sweep cut short by that goes on from where it stopped).
 */

/** How many due reminders one page of a look reads, and the most in flight at once. */
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

/** The keyset that continues after `pause` in the reminder scan's order. */
const afterOf = (pause: PauseRecord): PauseScanAfter => ({
  at: definedOf(pause.remindAt, "a pause the reminder scan found has a reminder"),
  tenantId: pause.tenantId,
  pauseId: pause.pauseId,
});

/** One instance's reminder look: the reminders it started, and where a cut-short sweep goes on. */
export class ReminderLook {
  readonly #inFlight = new Map<string, Promise<void>>();
  /** Where a sweep cut short by the cap went on from: the next one continues after it. */
  #resumeAfter: PauseScanAfter | undefined;

  constructor(private readonly sources: ReminderSources) {}

  /** Resolves once the reminders in flight ended (the instance's stop awaits them). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  /** One look: the due reminders page by page from the cursor, each started once. */
  async run(): Promise<void> {
    const { pauses, clock, signal } = this.sources;
    const now = clock.now();
    let after = this.#resumeAfter;
    this.#resumeAfter = undefined;
    for (;;) {
      const page = await pauses.findPendingByRemindAtBefore(now, REMINDER_PAGE, after);
      for (const pause of page) {
        if (signal.aborted) return;
        const key = `${pause.tenantId}\0${pause.pauseId}`;
        if (!this.#inFlight.has(key)) {
          if (this.#inFlight.size >= REMINDER_PAGE) {
            this.#resumeAfter = after;
            return;
          }
          // until it writes or ends: a pause nobody here can remind ends in one read and takes
          // no place of the cap, so it cannot hold the reminders behind it back (#1092)
          await this.#start(key, pause, now);
        }
        after = afterOf(pause);
      }
      // the last page: the sweep is over, the next look starts from the earliest again
      if (page.length < REMINDER_PAGE) return;
    }
  }

  /**
   * Starts the reminder of `pause`; its failure is told, never thrown. Resolves once it decided
   * what it is: it writes or it ended without writing: only then does the look go on to the next.
   */
  #start(key: string, pause: PauseRecord, now: Date): Promise<void> {
    let decide: () => void = () => undefined;
    const decided = new Promise<void>((resolve) => {
      decide = resolve;
    });
    const reminder = this.#remind(pause, now, () => {
      decide();
    })
      .catch((error: unknown) => {
        // a stop cut it: the reminder stays due for the next instance's look
        if (this.sources.signal.aborted) return;
        const text = `the reminder of a pause of execution ${pause.rootExecutionId} failed: ${String(error)}`;
        this.sources.log.warn("pause.reminder-failed", text, {
          tenantId: pause.tenantId,
          executionId: pause.rootExecutionId,
        });
      })
      .finally(() => {
        this.#inFlight.delete(key);
        decide();
      });
    this.#inFlight.set(key, reminder);
    return decided;
  }

  async #remind(pause: PauseRecord, now: Date, onWriting: () => void): Promise<void> {
    const { pauses, records, bundles, recipientsOf, delivered } = this.sources;
    const record = await records.findByTenantIdAndRunId(pause.tenantId, pause.rootExecutionId);
    if (record === undefined || !bundles.has(record.workflow)) return;
    onWriting();
    const done = await pauses.remindByTenantIdAndPauseId(
      pause.tenantId,
      pause.pauseId,
      now,
      recipientsOf(pause),
    );
    if (done) delivered();
  }
}

/** The reminder look as a look of the pause timers (`pause-timers.ts`): its name, and one look. */
export const reminderLookOf = (
  infrastructure: Pick<Infrastructure, "pausedExecutions" | "records" | "clock">,
  log: FrameworkLog,
  notices: Pick<ReminderSources, "bundles" | "recipientsOf" | "delivered">,
  signal: AbortSignal,
): TimerLook => {
  const look = new ReminderLook({
    pauses: infrastructure.pausedExecutions,
    records: infrastructure.records,
    clock: infrastructure.clock,
    ...notices,
    log,
    signal,
  });
  return { name: "reminders", run: () => look.run(), settled: () => look.settled() };
};
