import type { ExecutionLeases, HeldExecutionLease } from "../execution-leases.js";
import { leaseReleases } from "../lease-releases.js";
import type {
  ChildExecutionQueueRepository,
  QueuedChildExecution,
} from "../../infrastructure/child-execution-queue.repository.js";
import type { Clock } from "../../infrastructure/clock.js";
import { ExecutionRecordStatus } from "../../infrastructure/execution-record.repository.js";
import type { ExecutionTreeRepository } from "../../infrastructure/execution-tree.repository.js";
import { treeKeyOf } from "../../infrastructure/in-memory-database.js";
import type { FrameworkLog } from "../../infrastructure/logger.js";
import { SWEEP_EVERY } from "../../infrastructure/recovery.js";
import { remoteChildSignals } from "../../flow/runtime/remote/remote-child-signals.js";
import type { StepCapacity } from "../step-slots.js";
import { isSameRunningClaim, watchRunningChild } from "./child-registry.js";
import { runQueuedChild, type QueuedChildParts } from "./queued-child-run.js";

/**
 * The claims of one application instance (#333 PR 2, PR 4, S5, S7, S9): it claims queued children
 * while it has a free step slot (#332) — at once when a child is queued in this process, and at
 * every sweep (`SWEEP_EVERY`) for the ones queued elsewhere. Each claimed child runs under a 30 s
 * lease in `ExecutionLeaseRepository` (`(tenantId, childExecutionId)`) on its own thread; a crash
 * or a graceful stop past `shutdownTimeout` (S7) leaves the queue row `Running` so a live worker
 * reclaims it once its lease is free and continues it from its last checkpoint.
 */

export interface ChildWorkerParts extends QueuedChildParts {
  readonly queue: ChildExecutionQueueRepository;
  readonly leases: ExecutionLeases;
  readonly trees: ExecutionTreeRepository;
  readonly clock: Clock;
  readonly log: FrameworkLog;
  readonly capacity?: StepCapacity | undefined;
  readonly interruption: AbortSignal;
}

export interface ChildWorkers {
  stop(): Promise<void>;
}

class Workers implements ChildWorkers {
  readonly #stopped = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  readonly #preHeld = new Map<string, HeldExecutionLease>();
  readonly #reclaiming = new Set<string>();
  readonly #onQueued: () => void;
  readonly #unsubscribe: () => void;
  readonly #loop: Promise<void>;
  #looking: Promise<void> | undefined;
  #asked = 0;

  constructor(private readonly parts: ChildWorkerParts) {
    this.#onQueued = () => {
      void this.#look();
    };
    const unq = remoteChildSignals.onQueued(this.#onQueued);
    const unr = remoteChildSignals.onRunning((row) => {
      void this.#reclaim(row);
    });
    this.#unsubscribe = () => {
      unq();
      unr();
    };
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

  #room(): number {
    const cap = this.parts.capacity;
    return cap === undefined ? Number.POSITIVE_INFINITY : cap.freeSlots() - this.#running.size;
  }

  #look(): Promise<void> {
    this.#asked += 1;
    this.#looking ??= this.#drainLooks().finally(() => {
      this.#looking = undefined;
    });
    return this.#looking;
  }

  async #drainLooks(): Promise<void> {
    while (this.#asked > 0 && !this.#stopped.signal.aborted) {
      this.#asked = 0;
      await this.#claimAll();
    }
  }

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
    const stopClaiming = remoteChildSignals.enterClaim(key);
    const finish = (ran: boolean): void => {
      this.#running.delete(key);
      remoteChildSignals.ended(key);
      if (ran) void this.#look();
    };
    const done = this.#run(row, stopClaiming).then(finish, () => {
      finish(false);
    });
    this.#running.set(key, done);
  }

  async #run(row: QueuedChildExecution, stopClaiming: () => void): Promise<boolean> {
    const { tenantId, executionId } = row;
    const key = treeKeyOf(tenantId, executionId);
    let lease = this.#preHeld.get(key);
    this.#preHeld.delete(key);
    try {
      lease ??= await this.parts.leases.tryHold({ tenantId, rootExecutionId: executionId });
    } finally {
      stopClaiming();
    }
    if (lease === undefined) {
      await this.parts.queue.saveIfAbsent({ ...row, status: ExecutionRecordStatus.Queued });
      remoteChildSignals.queued(this.#onQueued);
      return false;
    }
    await this.#executeClaimed(row, lease);
    return true;
  }

  async #executeClaimed(row: QueuedChildExecution, lease: HeldExecutionLease): Promise<void> {
    const { tenantId, executionId } = row;
    const { queue, interruption, log } = this.parts;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, interruption, lease.signal]);
    const watching = watchRunningChild(this.parts, row, stop);
    try {
      const end = await runQueuedChild(this.parts, row, lease, signal);
      if (end === undefined) return;
      const done = await queue.completeByTenantIdAndExecutionId(tenantId, executionId, end);
      if (!done && !stop.signal.aborted) {
        const text = `child execution ${executionId} ended, but its tree no longer waits for it`;
        log.warn("child-queue.not-completed", text, { executionId, tenantId });
      }
    } finally {
      stop.abort();
      await watching;
      await lease.release();
    }
  }

  #canReclaim(key: string): boolean {
    if (this.#stopped.signal.aborted || this.#room() <= 0) return false;
    if (this.#running.has(key) || this.#reclaiming.has(key)) return false;
    return !remoteChildSignals.isClaiming(key) && !leaseReleases.isYielded(key);
  }

  async #reclaim(row: QueuedChildExecution): Promise<void> {
    const { tenantId, executionId } = row;
    const key = treeKeyOf(tenantId, executionId);
    if (!this.#canReclaim(key)) return;
    this.#reclaiming.add(key);
    try {
      const current = await this.parts.queue
        .findByTenantIdAndExecutionId(tenantId, executionId)
        .catch(() => undefined);
      if (!isSameRunningClaim(current, row)) return;
      const lease = await this.parts.leases.tryHold({ tenantId, rootExecutionId: executionId });
      if (lease === undefined) return;
      const queuedAt = this.parts.clock.now();
      await this.parts.queue.saveIfAbsent({
        ...current,
        status: ExecutionRecordStatus.Queued,
        queuedAt,
      });
      this.#preHeld.set(key, lease);
      await this.#look();
    } finally {
      this.#reclaiming.delete(key);
    }
  }
}

export const startChildWorkers = (parts: ChildWorkerParts): ChildWorkers => new Workers(parts);
