import {
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  IdGenerator,
  Injectable,
  type QueuedChildExecution,
} from "../../../src/index.js";
import { InMemoryChildExecutionQueueRepository } from "../../../src/infrastructure/child-execution-queue.repository.js";
import {
  InMemoryExecutionRecordRepository,
  type ExecutionRecordStatus,
} from "../../../src/infrastructure/execution-record.repository.js";
import type { Turn } from "../../../src/terns/index.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { Application } from "../../../src/application/application.js";
import { seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow } from "./claim-room.workflow.js";

/**
 * #923 AC3 — a store whose call is never answered: from the moment the test sets a flag, the
 * child queue's claim and the record store's look at the running executions return a promise that
 * never settles, as a call to a server that went quiet does.
 */
export const hung = { claim: false, records: false, calls: 0 };

export const resetHung = (): void => {
  hung.claim = false;
  hung.records = false;
  hung.calls = 0;
};

const never = <T>(): Promise<T> => {
  hung.calls += 1;
  return new Promise<T>(() => undefined);
};

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class HungQueueRepository extends InMemoryChildExecutionQueueRepository {
  override claimFirstByStatusQueuedOrderByDepthDesc(): Promise<QueuedChildExecution | undefined> {
    return hung.claim ? never() : super.claimFirstByStatusQueuedOrderByDepthDesc();
  }
}

@Injectable({ deps: [Clock, IdGenerator] })
export class HungRecordRepository extends InMemoryExecutionRecordRepository {
  override findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<Turn[]> {
    return hung.records ? never() : super.findByStatus(status, limit, after);
  }
}

/** The claim-room workflows (children on any instance) on stores that can go quiet. */
@Application({
  name: "hung-store-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow],
  budgets: TEST_BUDGETS,
  maxConcurrentSteps: 3,
  shutdownTimeout: seconds(60),
  providers: [HungQueueRepository, HungRecordRepository, RecordingLogger],
})
export class HungStoreApplication {}
