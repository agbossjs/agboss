import { isCancelRequested } from "../cancel-requests.js";
import type { ChildExecutionQueueRepository } from "../../infrastructure/child-execution-queue.repository.js";
import type { QueuedChildExecution } from "../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import type { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import { treeKeyOf } from "../../infrastructure/in-memory-database.js";
import type { FrameworkLog } from "../../infrastructure/logger.js";
import { SWEEP_EVERY } from "../../infrastructure/recovery.js";
import { remoteChildSignals } from "../../flow/runtime/remote/remote-child-signals.js";
import { ExecutionCancelledError } from "../../core/errors.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import type { StepCapacity } from "../step-slots.js";
import { runQueuedChild, type QueuedChildParts } from "./queued-child-run.js";

/**
 * The claims of one application instance (#333 PR 2, S5): it claims queued children while it has a
 * free step slot (#332 — each child it runs holds one of them in this count; no cap → every queued
 * child) — at once when a child is queued in this process, and at every sweep (`SWEEP_EVERY`) for
 * the ones queued elsewhere. Each claimed child runs on its own thread to its end, its row
 * completed, its parent woken. While it runs, the worker looks every 10 s whether its tree still
 * waits for it: a cancel request (#360) or the tree's end (its rows removed) stops it. Stopped
 * with the instance (`app.close()`); the children it still runs are interrupted with the rest.
 */

/** How often a running child's tree is looked at: a cancel or the tree's end stops it. */
const WATCH_EVERY: Milliseconds = seconds(10);

/** What an instance's claims work with. */
export interface ChildWorkerParts extends QueuedChildParts {
  readonly queue: ChildExecutionQueueRepository;
  readonly trees: ExecutionTreeRepository;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  /** The instance's step slots (#332); absent = no cap. */
  readonly capacity?: StepCapacity | undefined;
  /** Aborted at the end of the instance's shutdown timeout: the running children stop. */
  readonly interruption: AbortSignal;
}

/** The claims of one instance. */
export interface ChildWorkers {
  /** Stops claiming; resolves when the children it runs ended. */
  stop(): Promise<void>;
}

class Workers implements ChildWorkers {
  readonly #stopped = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  readonly #loop: Promise<void>;
  #looking = false;
  /** Looks asked while one ran: it goes round once more. */
  #asked = 0;

  constructor(private readonly parts: ChildWorkerParts) {
    this.#unsubscribe = remoteChildSignals.onQueued(() => {
      void this.#look();
    });
    this.#loop = this.#sweep();
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    this.#unsubscribe();
    await this.#loop;
    await Promise.allSettled([...this.#running.values()]);
  }

  async #sweep(): Promise<void> {
    while (!this.#stopped.signal.aborted) {
      await this.#look();
      await this.parts.clock.sleep(SWEEP_EVERY, this.#stopped.signal);
    }
  }

  /** How many more children this instance takes now. */
  #room(): number {
    const { capacity } = this.parts;
    if (capacity === undefined) return Number.POSITIVE_INFINITY;
    return capacity.freeSlots() - this.#running.size;
  }

  /** Claims while there is room and a queued child; a look asked meanwhile runs once more. */
  async #look(): Promise<void> {
    this.#asked += 1;
    if (this.#looking) return;
    this.#looking = true;
    try {
      while (this.#asked > 0 && !this.#stopped.signal.aborted) {
        this.#asked = 0;
        await this.#claimAll();
      }
    } finally {
      this.#looking = false;
    }
  }

  /** Claims and starts children while there is room and one is queued. */
  async #claimAll(): Promise<void> {
    while (!this.#stopped.signal.aborted && this.#room() > 0) {
      const claimed = await this.#claim();
      if (claimed === undefined) return;
      this.#start(claimed);
    }
  }

  async #claim(): Promise<QueuedChildExecution | undefined> {
    try {
      return await this.parts.queue.claimFirstByStatusQueuedOrderByDepthDesc();
    } catch (error) {
      this.parts.log.warn(
        "child-queue.failed",
        `the child queue could not be read: ${String(error)}`,
        {},
      );
      return undefined;
    }
  }

  #start(row: QueuedChildExecution): void {
    const key = treeKeyOf(row.tenantId, row.executionId);
    const done = this.#run(row).finally(() => {
      this.#running.delete(key);
      remoteChildSignals.ended(key);
      void this.#look();
    });
    this.#running.set(key, done);
  }

  async #run(row: QueuedChildExecution): Promise<void> {
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, this.parts.interruption]);
    const watching = this.#watch(row, stop);
    try {
      const end = await runQueuedChild(this.parts, row, signal);
      const isCompleted = await this.parts.queue.completeByTenantIdAndExecutionId(
        row.tenantId,
        row.executionId,
        end,
      );
      if (!isCompleted && !stop.signal.aborted)
        this.parts.log.warn(
          "child-queue.not-completed",
          `child execution ${row.executionId} ended, but its tree no longer waits for it`,
          { executionId: row.executionId, tenantId: row.tenantId },
        );
    } finally {
      stop.abort();
      await watching;
    }
  }

  /** Every 10 s while the child runs: its tree cancelled or ended stops it. */
  async #watch(row: QueuedChildExecution, stop: AbortController): Promise<void> {
    const tree = { tenantId: row.tenantId, rootExecutionId: row.rootExecutionId };
    for (;;) {
      await this.parts.clock.sleep(WATCH_EVERY, stop.signal);
      if (stop.signal.aborted) return;
      const stillQueued = await this.parts.queue
        .findByTenantIdAndExecutionId(row.tenantId, row.executionId)
        .catch(() => row);
      if (stillQueued === undefined || (await isCancelRequested(this.parts.trees, tree))) {
        stop.abort(new ExecutionCancelledError("the child's tree was cancelled or ended"));
        return;
      }
    }
  }
}

/** The claims of an instance, started now (its components have started). */
export const startChildWorkers = (parts: ChildWorkerParts): ChildWorkers => new Workers(parts);
