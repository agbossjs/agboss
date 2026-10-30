import type { PausedExecutionRepository } from "./paused-execution.repository.js";
import type { MeshRequestRepository } from "./mesh-request.repository.js";
import type { FencedEffectRepository } from "./fenced-effect.repository.js";
import type { ExecutionLeaseEventRepository } from "./execution-lease-event.repository.js";
import type { OutboundCallRepository } from "./outbound-call.repository.js";
import type { ExecutionHistoryRepository } from "./execution-history.repository.js";
import type { Clock } from "./clock.js";
import { isHandedOver } from "../app/handed-over.js";
import { problemOf, type RecoverRoot, type RecoveryProblem } from "../app/recover-root.js";
import type { Tern } from "../terns/index.js";
import { seconds, type Milliseconds } from "../units/index.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import type { FrameworkLog } from "./logger.js";
import type { StepCapacity } from "../app/step-slots.js";

/**
 * Automatic recovery (#265 S30): every application instance looks for the roots left `running` —
 * at its start and then every lease length — and continues each whose lease it can take (its
 * holder died, or stopped and released it) from its last checkpoint. A root this instance is not
 * compatible with is left to another one and logged once. With the in-memory defaults nothing
 * survives a restart, so there is nothing to recover; recovery works with persistent stores.
 * Each look also removes what the stores keep past its retention: the resolved
 * pause records (#267 S107), the mesh requests' answers (#398), the kept executions (#401), the
 * fenced effects' results and marks (#500) and the lease log's rows (#501).
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

/**
 * What the sweep reads and continues: the records, each workflow's recovery by its name, the clock;
 * and the stores it removes old rows from.
 */
export interface RecoverySources extends RetentionSources {
  readonly records: ExecutionRecordRepository;
  readonly workflows: ReadonlyMap<string, RecoverRoot>;
  /** Where its problems go: the application's log. */
  readonly log: FrameworkLog;
  /** Stops the recoveries in flight like the app's other executions (the shutdown timeout). */
  readonly signal: AbortSignal;
  /** The instance's step slots (#332); absent = no cap, every recoverable root is taken. */
  readonly capacity?: StepCapacity | undefined;
}

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
      await removeExpired(this.sources, (text) => {
        this.#log({ code: "recovery.failed", text, isBroken: true });
      });
      this.#lastSweptAt = this.sources.clock.now();
      await this.sources.clock.sleep(SWEEP_EVERY, this.#stopped.signal);
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

/**
 * What every look of the recovery sweep removes once its retention is over, on the `Clock`: the
 * resolved pause records (#267 S107), the trusted mesh requests' answers (#398 PR 2), the kept
 * executions that ended (#401 PR 1), the fenced effects' results and marks (#500) and the lease
 * log's rows (#501). A store that fails is reported
 * and asked again at the next look.
 */

/** The stores the sweep removes old rows from, and how long each keeps them. */
export interface RetentionSources {
  readonly clock: Clock;
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
  /** The fenced effects' results and marks (#500), removed after `fencedEffects.retention`. */
  readonly fencedEffects?: FencedEffectRepository<unknown> | undefined;
  readonly fencedEffectRetention?: Milliseconds | undefined;
  /** The lease log (#501) and `@Application({ leaseEventRetention })`: older rows are removed. */
  readonly leaseEvents?: ExecutionLeaseEventRepository | undefined;
  readonly leaseEventRetention?: Milliseconds | undefined;
  /** The ended outbound calls (#505), removed after `outboundCalls.retention`; never a pending one. */
  readonly outboundCalls?: OutboundCallRepository | undefined;
  readonly outboundCallRetention?: Milliseconds | undefined;
}

/** One kind of rows: what they are, how they are removed before a cutoff, and how long they stay. */
interface Expiry {
  readonly what: string;
  readonly remove: ((cutoff: Date) => Promise<void>) | undefined;
  readonly retention: number | undefined;
}

const expiriesOf = (sources: RetentionSources): readonly Expiry[] => {
  const { pauses, meshRequests, executionHistory, fencedEffects, leaseEvents, outboundCalls } =
    sources;
  return [
    {
      what: "the resolved pause records",
      remove: (cutoff) => pauses.deleteResolvedBefore(cutoff),
      retention: sources.pauseRecordRetention,
    },
    {
      what: "the mesh requests' answers",
      remove: meshRequests && ((cutoff) => meshRequests.deleteCreatedBefore(cutoff)),
      retention: sources.idempotencyRetention,
    },
    {
      what: "the kept execution records",
      remove: executionHistory && ((cutoff) => executionHistory.deleteByEndedAtBefore(cutoff)),
      retention: sources.executionRecordRetention,
    },
    {
      what: "the fenced effects' results",
      remove: fencedEffects && ((cutoff) => fencedEffects.deleteByStoredAtBefore(cutoff)),
      retention: sources.fencedEffectRetention,
    },
    {
      what: "the lease log's old rows",
      remove: leaseEvents && ((cutoff) => leaseEvents.deleteByOccurredAtBefore(cutoff)),
      retention: sources.leaseEventRetention,
    },
    {
      what: "the ended outbound calls",
      remove: outboundCalls && ((cutoff) => outboundCalls.deleteByEndedAtBefore(cutoff)),
      retention: sources.outboundCallRetention,
    },
  ];
};

/** Removes every kind of rows past its retention; `report` hears of each store that failed. */
export async function removeExpired(
  sources: RetentionSources,
  report: (text: string) => void,
): Promise<void> {
  for (const { what, remove, retention } of expiriesOf(sources)) {
    if (remove === undefined || retention === undefined) continue;
    try {
      await remove(new Date(sources.clock.now().getTime() - retention));
    } catch (error) {
      report(`${what} could not be removed: ${String(error)}`);
    }
  }
}
