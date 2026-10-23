import { isHandedOver } from "../app/handed-over.js";
import type { RecoverRoot } from "../app/recover-root.js";
import { IncompatibleResumeError } from "../run/resume-guard.js";
import type { Tern } from "../terns/index.js";
import { seconds, type Milliseconds } from "../units/index.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import type { MeshRequestRepository } from "./mesh-request.repository.js";
import type { ExecutionHistoryRepository } from "./execution-history.repository.js";
import type { Clock } from "./clock.js";
import type { FrameworkLog } from "./logger.js";
import type { PausedExecutionRepository } from "./paused-execution.repository.js";
import type { StepCapacity } from "../app/step-slots.js";

/**
 * Automatic recovery (#265 S30): every application instance looks for the roots left `running` —
 * at its start and then every lease length — and continues each whose lease it can take (its
 * holder died, or stopped and released it) from its last checkpoint. A root this instance is not
 * compatible with is left to another one and logged once. With the in-memory defaults nothing
 * survives a restart, so there is nothing to recover; recovery works with persistent stores.
 * Each look also removes the resolved pause records older than `pauseRecordRetention` (#267 S107).
 * An instance that caps its steps (#332, `@Application({ maxConcurrentSteps })`) starts at most as
 * many recoveries per look as it has free step slots, none when it is full — the orphans are left to
 * an idle instance; a look cut short by that goes on from where it stopped next time, so every
 * record is reached in turn.
 */

/** How often an instance looks: the lease length, so an expired lease is found within one more. */
export const SWEEP_EVERY: Milliseconds = seconds(30);

/** How many `running` records one look-up reads at a time. */
const PAGE = 50;

/** The recovery sweep of one application instance. */
export interface RecoverySweep {
  /** Stops looking (the first step of a graceful stop); resolves when its recoveries ended. */
  stop(): Promise<void>;
  /**
   * When its last look ended — its start before the first (#300): liveness reads it, a sweep stuck
   * in a store never ends one.
   */
  lastSweptAt(): Date;
  /** Whether `stop()` was called. */
  isStopped(): boolean;
}

/** What the sweep reads and continues: the records, each workflow's recovery by its name, the clock. */
export interface RecoverySources {
  readonly records: ExecutionRecordRepository;
  readonly workflows: ReadonlyMap<string, RecoverRoot>;
  readonly clock: Clock;
  /** Where its problems go: the application's log. */
  readonly log: FrameworkLog;
  /** Stops the recoveries in flight like the app's other executions (the shutdown timeout). */
  readonly signal: AbortSignal;
  /** The application's pause records: the resolved ones are removed after their retention. */
  readonly pauses: PausedExecutionRepository;
  /** `@Application({ pauseRecordRetention })`: how long a resolved pause record is kept. */
  readonly pauseRecordRetention: Milliseconds;
  /** The trusted mesh requests' answers (#398 PR 2): removed after their retention. */
  readonly meshRequests?: MeshRequestRepository | undefined;
  /** `@Application({ mesh: { idempotencyRetention } })`: how long an answer is kept. */
  readonly idempotencyRetention?: number | undefined;
  /**
   * The kept root executions (#401 PR 1) and `@Application({ executionRecordRetention })`: a record
   * that ended longer ago than it is removed; none set → nothing is kept, nothing removed.
   */
  readonly executionHistory?: ExecutionHistoryRepository | undefined;
  readonly executionRecordRetention?: Milliseconds | undefined;
  /** The instance's step slots (#332); absent = no cap, every recoverable root is taken. */
  readonly capacity?: StepCapacity | undefined;
}

/** A recovery problem, for the log: at risk (left to another instance) or broken. */
interface RecoveryProblem {
  readonly code: string;
  readonly text: string;
  readonly isBroken: boolean;
  readonly executionId?: string;
  readonly tenantId?: string;
}

/** The problem of one record's recovery. */
const problemOf = (record: Tern, error: unknown): RecoveryProblem => {
  const ids = { executionId: record.runId ?? record.id, tenantId: record.tenantId };
  return error instanceof IncompatibleResumeError
    ? {
        code: "recovery.incompatible",
        text: `execution ${ids.executionId} is left to an instance of a compatible version: ${error.message}`,
        isBroken: false,
        ...ids,
      }
    : {
        code: "recovery.failed",
        text: `recovery of execution ${ids.executionId} failed: ${error instanceof Error ? error.message : String(error)}`,
        isBroken: true,
        ...ids,
      };
};

/** One instance's sweep: its look-ups, the recoveries it started, the problems it logged. */
class Sweeper implements RecoverySweep {
  readonly #stopped = new AbortController();
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #logged = new Set<string>();
  readonly #loop: Promise<void>;
  #lastSweptAt: Date;
  /** Where a look cut short by the free step slots stopped: the next one goes on after it. */
  #resumeAfter: string | undefined;

  constructor(private readonly sources: RecoverySources) {
    this.#lastSweptAt = sources.clock.now();
    this.#loop = this.#run();
  }

  lastSweptAt(): Date {
    return this.#lastSweptAt;
  }

  isStopped(): boolean {
    return this.#stopped.signal.aborted;
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    await this.#loop;
    await Promise.allSettled([...this.#inFlight.values()]);
  }

  async #run(): Promise<void> {
    while (!this.#stopped.signal.aborted) {
      try {
        await this.#sweep();
      } catch (error) {
        // a store that failed is asked again at the next sweep
        this.#log({
          code: "recovery.failed",
          text: `recovery could not list the running executions: ${String(error)}`,
          isBroken: true,
        });
      }
      await this.#forgetResolvedPauses();
      await this.#forgetMeshRequests();
      await this.#forgetExecutionRecords();
      this.#lastSweptAt = this.sources.clock.now();
      await this.sources.clock.sleep(SWEEP_EVERY, this.#stopped.signal);
    }
  }

  /** The resolved pause records whose retention is over, removed (#267 S107). */
  async #forgetResolvedPauses(): Promise<void> {
    const { clock, pauses, pauseRecordRetention } = this.sources;
    const cutoff = new Date(clock.now().getTime() - pauseRecordRetention);
    try {
      await pauses.deleteResolvedBefore(cutoff);
    } catch (error) {
      this.#log({
        code: "recovery.failed",
        text: `the resolved pause records could not be removed: ${String(error)}`,
        isBroken: true,
      });
    }
  }

  /** The trusted mesh requests whose retention is over, removed (#398 PR 2). */
  async #forgetMeshRequests(): Promise<void> {
    const { clock, meshRequests, idempotencyRetention } = this.sources;
    if (meshRequests === undefined || idempotencyRetention === undefined) return;
    try {
      await meshRequests.deleteCreatedBefore(
        new Date(clock.now().getTime() - idempotencyRetention),
      );
    } catch (error) {
      const text = `the mesh requests' answers could not be removed: ${String(error)}`;
      this.#log({ code: "recovery.failed", text, isBroken: true });
    }
  }

  /** The kept executions that ended longer ago than their retention, removed (#401 PR 1). */
  async #forgetExecutionRecords(): Promise<void> {
    const { clock, executionHistory, executionRecordRetention } = this.sources;
    if (executionHistory === undefined || executionRecordRetention === undefined) return;
    try {
      await executionHistory.deleteByEndedAtBefore(
        new Date(clock.now().getTime() - executionRecordRetention),
      );
    } catch (error) {
      const text = `the kept execution records could not be removed: ${String(error)}`;
      this.#log({ code: "recovery.failed", text, isBroken: true });
    }
  }

  /** How many recoveries this look may start: the free step slots (#332), else every one. */
  #recoveriesAllowed(): number {
    const { capacity } = this.sources;
    return capacity === undefined ? Number.POSITIVE_INFINITY : capacity.freeSlots();
  }

  /**
   * Every `running` record, page by page; each one's recovery started, not awaited — at most as
   * many as the free step slots (#332): a look cut short remembers where it stopped.
   */
  async #sweep(): Promise<void> {
    let allowed = this.#recoveriesAllowed();
    if (allowed <= 0) return;
    let after = this.#resumeAfter;
    this.#resumeAfter = undefined;
    for (;;) {
      const page = await this.sources.records.findByStatus(
        ExecutionRecordStatus.Running,
        PAGE,
        after,
      );
      for (const record of page) {
        if (this.#stopped.signal.aborted) return;
        if (allowed <= 0) {
          this.#resumeAfter = after;
          return;
        }
        if (this.#recover(record)) allowed -= 1;
        after = record.id;
      }
      if (page.length < PAGE || this.#stopped.signal.aborted) return;
    }
  }

  /** Starts the record's recovery; `false` when it is not this instance's to start now. */
  #recover(record: Tern): boolean {
    const recoverRoot = this.sources.workflows.get(record.bundle);
    // another application's record on a shared store, or one already being continued here
    if (recoverRoot === undefined || this.#inFlight.has(record.id)) return false;
    const recovery = recoverRoot(record, this.sources.signal)
      .catch((error: unknown) => {
        if (isHandedOver(error)) return;
        this.#log(problemOf(record, error));
      })
      .finally(() => {
        this.#inFlight.delete(record.id);
      });
    this.#inFlight.set(record.id, recovery);
    return true;
  }

  /** Each problem once per instance (an incompatible root is seen again every sweep). */
  #log(problem: RecoveryProblem): void {
    const { code, text, executionId, tenantId } = problem;
    if (this.#logged.has(text)) return;
    this.#logged.add(text);
    const { log } = this.sources;
    const subject = { executionId, tenantId };
    if (problem.isBroken) log.error(code, text, subject);
    else log.warn(code, text, subject);
  }
}

/** Starts the sweep of one application instance: a look-up now, then every lease length. */
export const startRecoverySweep = (sources: RecoverySources): RecoverySweep => new Sweeper(sources);
