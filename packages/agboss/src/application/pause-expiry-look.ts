import type { ExpireRoot } from "../app/expire-root.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PauseScanAfter } from "../infrastructure/pause-notices.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { StepCapacity } from "../app/step-slots.js";
import type { TimerLook } from "./pause-timers.js";

/**
 * The expiry look of the pause timers (#941): every tick, the pending pauses whose deadline passed
 * (every tenant, the earliest first, pages of `EXPIRY_PAGE`) are grouped by their tree's root, and
 * each root's workflow — found through the root's record, as the orphan look does — expires them
 * under the tree's lease. A root another instance holds is skipped (its holder's drain or a later
 * look does it, I5); a root that fails is told and the others go on.
 *
 * Each root's expiry is started, not awaited (#1071), as the recovery sweep starts its recoveries:
 * the channel's handler and the pass that continues the run after it (it takes the step slots of
 * its steps) run beside the timer loop, so a long step never stalls the loop, the liveness probe
 * or another due pause. At most `maxConcurrentSteps` of them are in flight at once; a look cut
 * short by that goes on from where it stopped.
 *
 * A look is one sweep over the due pauses with a keyset cursor (#1070, #1072): a pause nobody here
 * can move (another application's tree, a removed workflow, an incompatible version, a tree in
 * use) stays pending, and is passed — never read again before the sweep ends — so it cannot hide
 * the due pauses behind it. The next sweep starts again from the earliest.
 */

/** How many due pauses one page of a look reads. */
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
  /** The instance's step slots (#332): at most `maxConcurrentSteps` expiries in flight; absent = no cap. */
  readonly capacity?: Pick<StepCapacity, "maxConcurrentSteps"> | undefined;
}

/** The keyset that continues after `pause` in the due-scan's order. */
const afterOf = (pause: PauseRecord): PauseScanAfter => ({
  at: pause.expiresAt ?? "",
  tenantId: pause.tenantId,
  pauseId: pause.pauseId,
});

/** One instance's expiry look: the expiries it started, and where a cut-short sweep goes on. */
export class ExpiryLook {
  readonly #inFlight = new Map<string, Promise<void>>();
  /** Where a look cut short by the cap went on from: the next one continues after it. */
  #resumeAfter: PauseScanAfter | undefined;

  constructor(private readonly sources: ExpirySources) {}

  /** Resolves once the expiries in flight ended (the instance's stop awaits them). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  /** One look: the due pauses page by page from the cursor, each root's expiry started once. */
  async run(): Promise<void> {
    const { pauses, clock, signal } = this.sources;
    const cap = this.sources.capacity?.maxConcurrentSteps ?? Number.POSITIVE_INFINITY;
    const started = new Set<string>();
    let after = this.#resumeAfter;
    this.#resumeAfter = undefined;
    for (;;) {
      const page = await pauses.findPendingByExpiresAtBefore(clock.now(), EXPIRY_PAGE, after);
      for (const pause of page) {
        if (signal.aborted) return;
        const key = `${pause.tenantId}\0${pause.rootExecutionId}`;
        // a root already moving here (an earlier look's, or this one's) is not started again
        if (!started.has(key) && !this.#inFlight.has(key)) {
          if (this.#inFlight.size >= cap) {
            this.#resumeAfter = after;
            return;
          }
          started.add(key);
          this.#start(key, pause);
        }
        after = afterOf(pause);
      }
      // the last page: the sweep is over, the next look starts from the earliest again
      if (page.length < EXPIRY_PAGE) return;
    }
  }

  /** Starts the expiry of the root of `pause`; its failure is told, never thrown. */
  #start(key: string, pause: PauseRecord): void {
    const { tenantId, rootExecutionId } = pause;
    const expiry = this.#expire(tenantId, rootExecutionId)
      .catch((error: unknown) => {
        // a stop cut it: the pause stays pending for the next instance's look
        if (this.sources.signal.aborted) return;
        const text = `the expiry of execution ${rootExecutionId} failed: ${String(error)}`;
        this.sources.log.warn("pause.expiry-failed", text, {
          tenantId,
          executionId: rootExecutionId,
        });
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });
    this.#inFlight.set(key, expiry);
  }

  async #expire(tenantId: string, rootExecutionId: string): Promise<void> {
    const { records, expiries, signal } = this.sources;
    // a root with no record (another application's tree on a shared store) is skipped
    const record = await records.findByTenantIdAndRunId(tenantId, rootExecutionId);
    if (record !== undefined) await expiries.get(record.bundle)?.(record, signal);
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
  capacity?: ExpirySources["capacity"],
): TimerLook => {
  const look = new ExpiryLook({
    pauses: infrastructure.pausedExecutions,
    records: infrastructure.records,
    expiries: new Map(workflows.map((one) => [one.deps.config.name, one.expire])),
    clock: infrastructure.clock,
    log,
    signal,
    capacity,
  });
  return { name: "expiry", run: () => look.run(), settled: () => look.settled() };
};
