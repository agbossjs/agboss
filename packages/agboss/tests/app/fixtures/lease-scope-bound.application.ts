import { EmptyEnvironment, Injectable } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Clock, IdGenerator } from "../../../src/infrastructure/clock.js";
import { InMemoryCheckpointSaver } from "../../../src/infrastructure/contracts.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import {
  InMemoryExecutionAuditLogRepository,
  type ExecutionAuditEventRecord,
} from "../../../src/infrastructure/execution-audit-log.repository.js";
import { InMemoryExecutionHistoryRepository } from "../../../src/infrastructure/execution-history.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import {
  InMemoryExecutionRecordRepository,
  type ExecutionRecordStatus,
} from "../../../src/infrastructure/execution-record.repository.js";
import {
  InMemoryExecutionTreeRepository,
  type ExecutionTree,
} from "../../../src/infrastructure/execution-tree.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import type { TurnOutcome } from "../../../src/turns/index.js";
import { processHoldPoints } from "../../../src/testing/faults/hold-points.js";
import { StoreHoldPoint } from "../../../src/testing/faults/store-points.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { hours, seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  GuestInboxChannel,
  UnwindGuestWorkflow,
} from "../../flow/runtime/fixtures/unwind-pause.workflow.js";
import { UnwindLog, UnwindWorkflow } from "../../flow/runtime/fixtures/unwind.workflow.js";
import { YieldLog, YieldOneWorkflow } from "./remote-child-yield.workflow.js";

/**
 * #928 lease scopes — stores whose next call of a named operation never answers, as a silent
 * server's does: `hangNext("records.complete")` holds the next such call for ever (deaf to every
 * signal); `calls` counts every call of an operation, answered or not.
 */
export const hung = { left: new Map<string, number>(), calls: new Map<string, number>() };

export const resetHung = (): void => {
  holdRenewAfterPut.after = 0;
  hung.left.clear();
  hung.calls.clear();
};

/** The next `times` calls of `operation` (after `skip` others) never answer. */
export const hangNext = (operation: string, times = 1, skip = 0): void => {
  hung.left.set(operation, times);
  hung.left.set(`${operation}#skip`, skip);
};

/** The put after which the lease renewal of the next put is held (0: none). */
export const holdRenewAfterPut = { after: 0 };

export const callsOf = (operation: string): number => hung.calls.get(operation) ?? 0;

/** Counts the call; whether it is one that never answers. */
function isHung(operation: string): boolean {
  hung.calls.set(operation, callsOf(operation) + 1);
  const skip = hung.left.get(`${operation}#skip`) ?? 0;
  if (skip > 0) {
    hung.left.set(`${operation}#skip`, skip - 1);
    return false;
  }
  const left = hung.left.get(operation) ?? 0;
  if (left <= 0) return false;
  hung.left.set(operation, left - 1);
  return true;
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

@Injectable({ deps: [Clock, IdGenerator] })
export class ScopedRecords extends InMemoryExecutionRecordRepository {
  override complete(turnId: string, outcome: TurnOutcome): Promise<void> {
    return isHung("records.complete") ? never() : super.complete(turnId, outcome);
  }

  override completeIfStatus(
    turnId: string,
    expected: ExecutionRecordStatus,
    outcome: TurnOutcome,
  ): Promise<boolean> {
    const operation = `records.completeIfStatus.${expected}`;
    return isHung(operation) ? never() : super.completeIfStatus(turnId, expected, outcome);
  }
}

@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class ScopedTrees extends InMemoryExecutionTreeRepository {
  override deleteAllInTree(tree: ExecutionTree): Promise<void> {
    return isHung("trees.deleteAllInTree") ? never() : super.deleteAllInTree(tree);
  }
}

@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class ScopedAudit extends InMemoryExecutionAuditLogRepository {
  override save(record: ExecutionAuditEventRecord): Promise<void> {
    return isHung("audit.save") ? never() : super.save(record);
  }
}

@Injectable()
export class ScopedCheckpoints extends InMemoryCheckpointSaver {
  override async put(
    ...args: Parameters<InMemoryCheckpointSaver["put"]>
  ): ReturnType<InMemoryCheckpointSaver["put"]> {
    if (isHung("checkpoint.put")) return never();
    const stored = await super.put(...args);
    // the lease's renewal that the next put makes first never answers
    if (callsOf("checkpoint.put") === holdRenewAfterPut.after)
      processHoldPoints.arm({ point: StoreHoldPoint.LeaseRenew });
    return stored;
  }
}

export const HeldLeases = withHoldPoints(InMemoryExecutionLeaseRepository);
export const HeldQueue = withHoldPoints(InMemoryChildExecutionQueueRepository);
export const HeldHistory = withHoldPoints(InMemoryExecutionHistoryRepository);

@Application({
  name: "lease-scope-bound-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnwindWorkflow, UnwindGuestWorkflow, YieldOneWorkflow],
  observers: [UnwindLog, YieldLog],
  providers: [
    ScopedRecords,
    ScopedTrees,
    ScopedAudit,
    ScopedCheckpoints,
    HeldLeases,
    HeldQueue,
    HeldHistory,
    GuestInboxChannel,
    RecordingLogger,
  ],
  budgets: TEST_BUDGETS,
  compensationTimeout: seconds(60),
  retention: { executionRecords: hours(24) },
})
export class LeaseScopeBoundApplication {}
