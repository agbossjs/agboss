import {
  ApplicationContext,
  Clock,
  StoreClock,
  Injectable,
  type ExecutionLease,
  type ExecutionLeaseTakeoverEvent,
  type OnExecutionLeaseTakeover,
  type FencedEffectEvent,
  type OnFencedEffect,
  type OnStepHandedOver,
  type StepHandedOverEvent,
  InMemoryFencedEffectRepository,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import {
  InMemoryExecutionAuditLogRepository,
  type ExecutionAuditEventRecord,
} from "../../../src/infrastructure/execution-audit-log.repository.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { hours, type Milliseconds } from "../../../src/units/index.js";
import {
  TEST_BUDGETS,
  TestApplicationDailyBudget,
  TestTenantDailyBudget,
} from "../../flow/fixtures/budgets.js";
import {
  ChargeWorkflow,
  DoubleChargeWorkflow,
  FencedExecutionBudget,
} from "./fenced-effect.workflow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { FarParentWorkflow } from "./fence-children.workflow.js";
import {
  AgentReleaseWorkflow,
  BookedReleaseWorkflow,
  ReleaseWorkflow,
  ToolEndLog,
} from "./fence.workflow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";

/**
 * #501 — the fence's release (fence.workflow.ts) and a parent waiting for an `AnyInstance` child
 * (fence-children.workflow.ts), observed by the audit log's hooks: an observer that keeps every
 * takeover event, one that throws, a lease store that names no previous holder (an external store
 * from before #501) and a audit log that cannot write.
 */

/** What the lease hooks saw, in order (reset with `resetAuditLog`). */
export const leaseSeen = {
  takeovers: [] as ExecutionLeaseTakeoverEvent[],
  handOvers: [] as StepHandedOverEvent[],
  fencedEffects: [] as FencedEffectEvent[],
};

export function resetAuditLog(): void {
  leaseSeen.takeovers.length = 0;
  leaseSeen.handOvers.length = 0;
  leaseSeen.fencedEffects.length = 0;
}

/** Keeps every takeover and hand-over event. */
@Injectable()
export class AuditLogObserver
  implements OnExecutionLeaseTakeover, OnStepHandedOver, OnFencedEffect
{
  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    leaseSeen.takeovers.push(event);
  }
  onStepHandedOver(event: StepHandedOverEvent): void {
    leaseSeen.handOvers.push(event);
  }
  onFencedEffect(event: FencedEffectEvent): void {
    leaseSeen.fencedEffects.push(event);
  }
}

/** Throws at every audit event: a broken observer. */
@Injectable()
export class ThrowingLeaseObserver
  implements OnExecutionLeaseTakeover, OnStepHandedOver, OnFencedEffect
{
  onExecutionLeaseTakeover(): void {
    throw new Error("the lease observer is broken");
  }
  onStepHandedOver(): void {
    throw new Error("the lease observer is broken");
  }
  onFencedEffect(): void {
    throw new Error("the lease observer is broken");
  }
}

/** A lease store that never says who it took a lease over from (`takenOverFrom` left out). */
@Injectable({ deps: [StoreClock, ApplicationContext, IN_MEMORY_DATABASE] })
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
          token: taken.token,
          expiresAt: taken.expiresAt,
          remaining: taken.remaining,
        };
  }
}

/** A audit log whose store is down: every save rejects. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class DownAuditLogRepository extends InMemoryExecutionAuditLogRepository {
  override save(record: ExecutionAuditEventRecord): Promise<void> {
    return Promise.reject(new Error(`the audit log is down (${record.kind})`));
  }
}

const WORKFLOWS = [ReleaseWorkflow, AgentReleaseWorkflow, BookedReleaseWorkflow, FarParentWorkflow];

@Application({
  name: "audit-log-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, AuditLogObserver],
  budgets: TEST_BUDGETS,
})
export class AuditLogApplication {}

@Application({
  name: "throwing-lease-observer-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: WORKFLOWS,
  observers: [ThrowingLeaseObserver, RecoveryLog, ToolEndLog, AuditLogObserver],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class ThrowingLeaseObserverApplication {}

@Application({
  name: "silent-takeover-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, AuditLogObserver],
  providers: [SilentTakeoverLeaseRepository],
  budgets: TEST_BUDGETS,
})
export class SilentTakeoverApplication {}

@Application({
  name: "down-audit-log-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, AuditLogObserver],
  providers: [DownAuditLogRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class DownLeaseLogApplication {}

@Application({
  name: "kept-audit-log-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: WORKFLOWS,
  observers: [RecoveryLog, ToolEndLog, AuditLogObserver],
  retention: { executionRecords: hours(24) },
  budgets: TEST_BUDGETS,
})
export class KeptAuditLogApplication {}

/** #501 PR 3 — the charge of fenced-effect.workflow.ts, its fenced effect told to the audit log. */
@Application({
  name: "fenced-effect-events-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, DoubleChargeWorkflow],
  observers: [RecoveryLog, AuditLogObserver],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [InMemoryFencedEffectRepository],
})
export class FencedEffectEventsApplication {}

@Application({
  name: "throwing-fenced-effect-observer-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, DoubleChargeWorkflow],
  observers: [ThrowingLeaseObserver, RecoveryLog, AuditLogObserver],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
})
export class ThrowingFencedEffectObserverApplication {}
