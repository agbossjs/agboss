/**
 * Deliberately broken stores (#481 AC2): each breaks one rule of its contract, the way a real
 * store gets it wrong. The `*.contract-fixture.ts` files run a published suite against one of them.
 */
import type {
  ChildExecutionQueueWatch,
  ExecutionLease,
  QueuedChildExecution,
} from "../../../src/index.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { InMemoryExecutionRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import type { ExecutionTree } from "../../../src/index.js";
import type { TernOutcome } from "../../../src/terns/index.js";
import type { Milliseconds } from "../../../src/units/index.js";
import { MapExecutionLeaseRepository } from "./map-lease-store.js";

/** `acquire` ignores a valid holder: it hands the lease to whoever asks. */
export class HolderIgnoringLeaseRepository extends MapExecutionLeaseRepository {
  protected override isValid(_stored: ExecutionLease | undefined): boolean {
    return false;
  }
}

/** Reads the wall clock (`Date.now()`) instead of the framework's. */
export class WallClockLeaseRepository extends MapExecutionLeaseRepository {
  protected override now(): number {
    return Date.now();
  }
}

/** A claim that returns the row it claimed last again: the same child claimed twice. */
export class TwiceClaimingQueueRepository extends InMemoryChildExecutionQueueRepository {
  #lastClaimed: QueuedChildExecution | undefined;

  override async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<
    QueuedChildExecution | undefined
  > {
    const claimed = (await super.claimFirstByStatusQueuedOrderByDepthDesc()) ?? this.#lastClaimed;
    this.#lastClaimed = claimed;
    return claimed;
  }
}

/**
 * One claim marks the next queued child too and answers only the first (#720: PostgreSQL's claim
 * statement that updated several rows): the second is left `Running` for this instance, unheard.
 */
export class RowsSweepingQueueRepository extends InMemoryChildExecutionQueueRepository {
  override async claimFirstByStatusQueuedOrderByDepthDesc(): Promise<
    QueuedChildExecution | undefined
  > {
    const claimed = await super.claimFirstByStatusQueuedOrderByDepthDesc();
    await super.claimFirstByStatusQueuedOrderByDepthDesc();
    return claimed;
  }
}

/** `complete` answers as if it wrote, and loses the update. */
export class UpdateLosingRecordRepository extends InMemoryExecutionRecordRepository {
  override complete(_id: string, _outcome: TernOutcome): Promise<void> {
    return Promise.resolve();
  }
}

/** Deleting a tree leaves its rows. */
export class RowKeepingTreeRepository extends InMemoryExecutionTreeRepository {
  override deleteAllInTree(_tree: ExecutionTree): Promise<void> {
    return Promise.resolve();
  }
}

/** One turn of the event loop: the gap a network round trip leaves between a read and a write. */
const roundTrip = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Check, then write (#695): `acquire` decides the lease is free from what it read, a round trip
 * passes, then it writes the next epoch without checking again. Every other operation is sound, so
 * it passes every case of the lease contract but the races of two takes of a free lease.
 */
export class CheckThenWriteLeaseRepository extends MapExecutionLeaseRepository {
  #isChecked = false;

  protected override isValid(stored: ExecutionLease | undefined): boolean {
    return !this.#isChecked && super.isValid(stored);
  }

  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const isFree = this.isFreeNow(tenantId, rootExecutionId);
    await roundTrip();
    if (!isFree) return undefined;
    // the write, its check already made: what another instance did in the gap is not seen
    this.#isChecked = true;
    try {
      return await super.acquire(tenantId, rootExecutionId, lease);
    } finally {
      this.#isChecked = false;
    }
  }
}

/** The watches of every queue of the fixture's process (#777): one database, so one channel. */
const queueWatchers = new Set<() => void>();

/**
 * #777: a queue with a watch, as a networked store's `LISTEN` / `NOTIFY` is — every save that
 * queues a child wakes every open watch (a correct store, the suite's positive branch).
 */
export class NotifyingQueueRepository extends InMemoryChildExecutionQueueRepository {
  override async saveIfAbsent(child: QueuedChildExecution): Promise<boolean> {
    const isNew =
      (await this.findByTenantIdAndExecutionId(child.tenantId, child.executionId)) === undefined;
    const saved = await super.saveIfAbsent(child);
    if (saved && this.notifies(isNew)) for (const watcher of [...queueWatchers]) watcher();
    return saved;
  }

  override watchQueued(onQueued: () => void): Promise<ChildExecutionQueueWatch> {
    queueWatchers.add(onQueued);
    return Promise.resolve({
      close: () => {
        queueWatchers.delete(onQueued);
        return Promise.resolve();
      },
    });
  }

  /** Whether a save that queued a child notifies: every one. */
  protected notifies(_isNew: boolean): boolean {
    return true;
  }
}

/** #777: notifies only a child queued for the first time — one queued again (a resume) never wakes. */
export class InsertOnlyNotifyingQueueRepository extends NotifyingQueueRepository {
  protected override notifies(isNew: boolean): boolean {
    return isNew;
  }
}
