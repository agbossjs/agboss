/**
 * Deliberately broken stores (#481 AC2): each breaks one rule of its contract, the way a real
 * store gets it wrong. The `*.contract-fixture.ts` files run a published suite against one of them.
 */
import type { ExecutionLease, QueuedChildExecution } from "../../../src/index.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import { InMemoryExecutionRecordRepository } from "../../../src/infrastructure/execution-record.repository.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import type { ExecutionTree } from "../../../src/index.js";
import type { TernOutcome } from "../../../src/terns/index.js";
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
