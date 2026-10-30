import {
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  Injectable,
  type ExecutionLease,
  type ExecutionLeaseTakeoverEvent,
  type OnExecutionLeaseTakeover,
  type OnStepHandedOver,
  type StepHandedOverEvent,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import {
  InMemoryExecutionLeaseEventRepository,
  type ExecutionLeaseEventRecord,
} from "../../../src/infrastructure/execution-lease-event.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/instance-tokens.js";
import { hours, type Milliseconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { FarParentWorkflow } from "./fence-children.workflow.js";
import {
  AgentReleaseWorkflow,
  BookedReleaseWorkflow,
  ReleaseWorkflow,
  ToolEndLog,
} from "./fence.workflow.js";

/**
 * #501 — the fence's release (fence.workflow.ts) and a parent waiting for an `AnyInstance` child
 * (fence-children.workflow.ts), observed by the lease log's hooks: an observer that keeps every
 * takeover event, one that throws, a lease store that names no previous holder (an external store
 * from before #501) and a lease log that cannot write.
 */

/** What the lease hooks saw, in order (reset with `resetLeaseEvents`). */
export const leaseSeen = {
  takeovers: [] as ExecutionLeaseTakeoverEvent[],
  handOvers: [] as StepHandedOverEvent[],
};

export function resetLeaseEvents(): void {
  leaseSeen.takeovers.length = 0;
  leaseSeen.handOvers.length = 0;
}

/** Keeps every takeover and hand-over event. */
@Injectable()
export class LeaseEventObserver implements OnExecutionLeaseTakeover, OnStepHandedOver {
  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    leaseSeen.takeovers.push(event);
  }
  onStepHandedOver(event: StepHandedOverEvent): void {
    leaseSeen.handOvers.push(event);
  }
}

/** Throws at every lease event: a broken observer. */
@Injectable()
export class ThrowingLeaseObserver implements OnExecutionLeaseTakeover, OnStepHandedOver {
  onExecutionLeaseTakeover(): void {
    throw new Error("the lease observer is broken");
  }
  onStepHandedOver(): void {
    throw new Error("the lease observer is broken");
  }
}

/** A lease store that never says who it took a lease over from (`takenOverFrom` left out). */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class SilentTakeoverLeaseRepository extends InMemoryExecutionLeaseRepository {
  override async acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    const taken = await super.acquire(tenantId, rootExecutionId, lease);
    return taken === undefined
      ? undefined
      : {
          tenantId: taken.tenantId,
          rootExecutionId: taken.rootExecutionId,
          holderInstanceId: taken.holderInstanceId,
          leaseEpoch: taken.leaseEpoch,
          expiresAt: taken.expiresAt,
        };
  }
}

/** A lease log whose store is down: every save rejects. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class DownLeaseEventRepository extends InMemoryExecutionLeaseEventRepository {
  override save(record: ExecutionLeaseEventRecord): Promise<void> {
    return Promise.reject(new Error(`the lease log is down (${record.kind})`));
  }
}

const WORKFLOWS = [ReleaseWorkflow, AgentReleaseWorkflow, BookedReleaseWorkflow, FarParentWorkflow];

@Application({
  name: "lease-events-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, LeaseEventObserver],
  budgets: TEST_BUDGETS,
})
export class LeaseEventsApplication {}

@Application({
  name: "throwing-lease-observer-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: WORKFLOWS,
  observers: [ThrowingLeaseObserver, RecoveryLog, ToolEndLog, LeaseEventObserver],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class ThrowingLeaseObserverApplication {}

@Application({
  name: "silent-takeover-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, LeaseEventObserver],
  providers: [SilentTakeoverLeaseRepository],
  budgets: TEST_BUDGETS,
})
export class SilentTakeoverApplication {}

@Application({
  name: "down-lease-log-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, LeaseEventObserver],
  providers: [DownLeaseEventRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class DownLeaseLogApplication {}

@Application({
  name: "kept-lease-events-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, LeaseEventObserver],
  executionRecordRetention: hours(24),
  budgets: TEST_BUDGETS,
})
export class KeptLeaseEventsApplication {}
