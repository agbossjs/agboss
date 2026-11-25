import type { Clock } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import type { PauseScanAfter } from "../infrastructure/pause-notices.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { PauseStatus, type PauseRecord } from "../infrastructure/pause-record.js";
import { seconds } from "../units/index.js";
import { errorNamesOf } from "../app/error-names.js";
import type { TimerLook } from "./pause-timers.js";

/**
 * The re-send look of the pause timers (#946, AC2): every tick, the replacements of a reassignment
 * that are still `Pending` and unsent a while after they were made — the instance that reassigned
 * died, or its channel failed, between the store's transaction and the new send — are sent again by
 * the workflow of their tree, `replaces` and `assignee` as on the first try, and marked sent;
 * `send` is at-least-once, as a step's re-entry after a crash already is, and the compare-and-set of
 * `markSent` keeps one `opened`. No lease, no tree move: nothing of the run changes. A tree whose root
 * has no record of this instance's workflows is another application's on a shared store: left alone.
 * A pause that fails is told and the others go on; each is started, not awaited, so a slow channel never
 * stalls the timer loop, and one that is in flight is not started again.
 */

/** How many replacements one look reads and the most it has in flight. */
export const RESEND_PAGE = 50;

/** How long a replacement waits unsent before the look asks for it: the call that made it has had its turn. */
export const RESEND_AFTER = seconds(30);

/** One workflow's new send of a replacement of its trees; resolves once the channel was asked and it is marked sent. */
export type ResendReassigned = (pause: PauseRecord, signal: AbortSignal) => Promise<void>;

/** What the look reads and does. */
export interface ResendSources {
  readonly pauses: Pick<
    PausedExecutionRepository,
    "findPendingUnsentReassignedBefore" | "findByTenantIdAndPauseId"
  >;
  /** The roots' records: the workflow a tree belongs to. */
  readonly records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">;
  /** Each workflow's new send, by the bundle its records name. */
  readonly resends: ReadonlyMap<string, ResendReassigned>;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  /** Aborted by the instance's stop: the look ends between two pauses. */
  readonly signal: AbortSignal;
}

/** One instance's re-send look: the sends it started. */
export class ResendLook {
  readonly #inFlight = new Map<string, Promise<void>>();

  constructor(private readonly sources: ResendSources) {}

  /** Resolves once the sends in flight ended (the instance's stop awaits them). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  /** One look: the replacements still unsent after `RESEND_AFTER`, each one's send started once (not awaited: a slow channel never stalls the timer loop). */
  async run(): Promise<void> {
    const { pauses, clock, signal } = this.sources;
    const cutoff = new Date(clock.now().getTime() - RESEND_AFTER);
    // one sweep with a keyset cursor: a replacement nobody here can send (another application's, a
    // channel that keeps failing) is passed, never read again within the sweep, and hides none behind it
    let after: PauseScanAfter | undefined;
    for (;;) {
      const page = await pauses.findPendingUnsentReassignedBefore(cutoff, RESEND_PAGE, after);
      for (const pause of page) {
        if (signal.aborted) return;
        const key = `${pause.tenantId}\0${pause.pauseId}`;
        if (!this.#inFlight.has(key)) {
          const send = this.#resend(pause).finally(() => {
            this.#inFlight.delete(key);
          });
          this.#inFlight.set(key, send);
        }
        after = { at: pause.askedAt, tenantId: pause.tenantId, pauseId: pause.pauseId };
      }
      if (page.length < RESEND_PAGE) return;
    }
  }

  /** Sends `pause` again unless it was sent or closed meanwhile; its failure is told, never thrown. */
  async #resend(pause: PauseRecord): Promise<void> {
    const { pauses, records, resends, signal, log } = this.sources;
    try {
      const record = await records.findByTenantIdAndRunId(pause.tenantId, pause.rootExecutionId);
      const resend = record === undefined ? undefined : resends.get(record.workflow);
      if (resend === undefined) return;
      const now = await pauses.findByTenantIdAndPauseId(pause.tenantId, pause.pauseId);
      if (now?.status !== PauseStatus.Pending || now.isSent) return;
      await resend(now, signal);
    } catch (error) {
      // a stop cut it: the replacement stays unsent for the next instance's look
      if (signal.aborted) return;
      const text = `the new send of a reassigned pause of execution ${pause.rootExecutionId} failed (${errorNamesOf(error)})`;
      log.warn("pause.resend-failed", text, {
        tenantId: pause.tenantId,
        executionId: pause.rootExecutionId,
      });
    }
  }
}

/** One workflow of the instance, as the re-send look needs it: its name and its new send. */
export interface ResendingWorkflow {
  readonly deps: { readonly config: { readonly name: string } };
  readonly resend: ResendReassigned;
}

/** The re-send look as a look of the pause timers (`pause-timers.ts`): its name, and one look. */
export const resendLookOf = (
  infrastructure: Pick<Infrastructure, "pausedExecutions" | "records" | "clock">,
  log: FrameworkLog,
  workflows: readonly ResendingWorkflow[],
  signal: AbortSignal,
): TimerLook => {
  const look = new ResendLook({
    pauses: infrastructure.pausedExecutions,
    records: infrastructure.records,
    resends: new Map(workflows.map((one) => [one.deps.config.name, one.resend])),
    clock: infrastructure.clock,
    log,
    signal,
  });
  return { name: "resend", run: () => look.run(), settled: () => look.settled() };
};
