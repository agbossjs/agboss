import type { ExecutionLeases, HeldExecutionLease } from "../execution-leases.js";
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
import { claimRoomOf, type StepCapacity } from "../step-slots.js";
import { childTakeOf, isSameRunningClaim, watchRunningChild } from "./child-registry.js";
import { runQueuedChild, type QueuedChildParts } from "./queued-child-run.js";
import { announcePass } from "./child-end-event.js";
import { ChildQueueWatch } from "./child-queue-watch.js";
import { LookPacing, requeueIfStillClaimed } from "./look-pacing.js";

/**
 * The claims of one application instance (#333 PR 2, PR 4, S5, S7, S9): it claims queued children
 * while it has a free step slot (#332) — at once when a child is queued in this process or the
 * store's watch wakes it (#777: a child queued in another process), and at every sweep
 * (`SWEEP_EVERY`), which claims whatever a lost wake-up left queued. Each claimed child runs under a 30 s
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
  /** The claimed children at work here, by tree key: each one's queue row and its run. */
  readonly #running = new Map<string, QueuedChildExecution & { readonly done: Promise<void> }>();
  readonly #preHeld = new Map<string, HeldExecutionLease>();
  readonly #reclaiming = new Set<string>();
  readonly #onQueued: () => void;
  readonly #unsubscribe: () => void;
  readonly #loop: Promise<void>;
  #looking: Promise<void> | undefined;
  #asked = 0;
  readonly #watch: ChildQueueWatch;
  readonly #pacing: LookPacing;

  constructor(private readonly parts: ChildWorkerParts) {
    this.#pacing = new LookPacing(parts.clock, this.#stopped.signal);
    this.#onQueued = () => void this.#look();
    const unq = remoteChildSignals.onQueued(this.#onQueued);
    const unr = remoteChildSignals.onRunning((row) => void this.#reclaim(row));
    this.#unsubscribe = () => {
      unq();
      unr();
    };
    this.#watch = new ChildQueueWatch(parts.queue, this.#onQueued, parts.log);
    this.#loop = this.#sweep();
  }

  async stop(): Promise<void> {
    this.#stopped.abort();
    this.#unsubscribe();
    await this.#loop;
    await this.#watch.close();
    await Promise.allSettled([...this.#running.values()].map((child) => child.done));
  }

  async #sweep(): Promise<void> {
    while (!this.#stopped.signal.aborted) {
      await this.#watch.open();
      await this.#look();
      await this.parts.clock.sleep(SWEEP_EVERY, this.#stopped.signal);
    }
  }

  /** The children it may claim now: each claimed child counted once, by its slot or its claim (#767). */
  #room(): number {
    return claimRoomOf(this.parts.capacity, this.#running.values());
  }

  /** A look now, or — within the backoff of a refused take — one when it ends (a wake-up is never skipped). */
  #look(force = false): Promise<void> {
    const deferred = force ? undefined : this.#pacing.deferred(() => this.#look());
    if (deferred !== undefined) return deferred;
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
    this.#running.set(key, { ...row, done });
  }

  async #run(row: QueuedChildExecution, stopClaiming: () => void): Promise<boolean> {
    const { tenantId, executionId } = row;
    const key = treeKeyOf(tenantId, executionId);
    let lease = this.#preHeld.get(key);
    this.#preHeld.delete(key);
    try {
      const tree = { tenantId, rootExecutionId: executionId };
      lease ??= await this.parts.leases.tryHold(tree, childTakeOf(this.parts.queue, row, false));
    } finally {
      stopClaiming();
    }
    if (lease === undefined) {
      this.#pacing.refused(key);
      await requeueIfStillClaimed(this.parts.queue, row, this.#onQueued);
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
    let isRetired = false;
    try {
      const pass = await runQueuedChild(this.parts, row, lease, signal);
      if (pass === undefined) return;
      const done = await queue.completeByTenantIdAndExecutionId(tenantId, executionId, pass.end);
      // answered or failed: its lease is retired, no stale worker takes it again (#520)
      isRetired = pass.end.status !== ExecutionRecordStatus.Paused;
      // announced by the completion that won, never by its parent (#562), while this pass still
      // holds the lease; then the waiting parent reads the row, before the lease's cleanup (#917)
      await announcePass(queue, pass, done);
      remoteChildSignals.ended(treeKeyOf(tenantId, executionId));
      if (!done && !stop.signal.aborted) {
        const text = `child execution ${executionId} ended, but its tree no longer waits for it`;
        log.warn("child-queue.not-completed", text, { executionId, tenantId });
      }
    } finally {
      stop.abort();
      await watching;
      await lease.release({ isRetired });
    }
  }

  #canReclaim(key: string): boolean {
    if (this.#stopped.signal.aborted || this.#room() <= 0) return false;
    if (this.#running.has(key) || this.#reclaiming.has(key)) return false;
    // a child that waits for its own remote children keeps its lease, yielded in the store (#516)
    return !remoteChildSignals.isClaiming(key);
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
      const tree = { tenantId, rootExecutionId: executionId };
      const take = childTakeOf(this.parts.queue, current, true);
      const lease = await this.parts.leases.tryHold(tree, take);
      if (lease === undefined) return;
      const queuedAt = this.parts.clock.now();
      const requeued = { ...current, status: ExecutionRecordStatus.Queued, queuedAt };
      // the claim moved on since the take (#520): the lease goes back, never held unused
      if (!(await this.parts.queue.saveIfAbsent(requeued))) {
        await lease.release();
        return;
      }
      this.#preHeld.set(key, lease);
      await this.#look(true);
      // #720: kept for this look's own claim only — a child it did not start gets its lease back
      if (this.#preHeld.get(key) === lease && this.#preHeld.delete(key)) await lease.release();
    } finally {
      this.#reclaiming.delete(key);
    }
  }
}

export const startChildWorkers = (parts: ChildWorkerParts): ChildWorkers => new Workers(parts);
