import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  ApplicationContext,
  Clock,
  Injectable,
  InMemoryFencedEffectRepository,
  RateLimitRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import { Application } from "../../../src/application/application.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryRateLimitRepository } from "../../../src/infrastructure/rate-limit.repository.js";
import { withHoldPoints } from "../../../src/testing/faults/held-stores.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { start } from "../../helpers/flow.js";
import { ChargeWorkflow, FencedExecutionBudget } from "./fenced-effect.workflow.js";

/**
 * #928 — the charge workflow plus a step that takes a rate-limit slot, on stores a test can hold
 * (the lease store, which a test can kill, and the fenced-effect store, deaf to the step's signal) or hang by a flag (the slot store).
 */
export const HeldLeasesOfLeased = withHoldPoints(MortalExecutionLeaseRepository);
export const HeldFencedEffectsOfLeased = withHoldPoints(InMemoryFencedEffectRepository);

/** Whether the slot store's `acquire` never answers (reset by the test). */
export const slots = { hung: false, asked: 0 };

/** A slot store whose `acquire` never answers once `slots.hung` is set. */
@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
export class HungSlotRepository extends InMemoryRateLimitRepository {
  override acquire(
    ...args: Parameters<InMemoryRateLimitRepository["acquire"]>
  ): ReturnType<InMemoryRateLimitRepository["acquire"]> {
    slots.asked += 1;
    return slots.hung ? new Promise<never>(() => undefined) : super.acquire(...args);
  }
}

export class SlotReceiptDto {
  @Text({ prompt: "the slot's key" })
  key!: string;
}

@Action({
  name: "take-slot-action",
  description: "Takes one rate-limit slot",
  input: { message: WorkflowStartTextDto },
  output: SlotReceiptDto,
  deps: [RateLimitRepository],
})
export class TakeSlotAction {
  constructor(private readonly rateLimits: RateLimitRepository) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<SlotReceiptDto> {
    const key = input.message.value.text;
    const slot = await this.rateLimits.acquire(key, 1, seconds(60));
    return { key: slot?.key ?? "none" };
  }
}

@WorkflowStart({ name: "slot-workflow-start", description: "A key", input: WorkflowStartTextDto })
export class SlotWorkflowStart {}

@WorkflowFinish({ name: "slot-workflow-finish", description: "The slot", output: SlotReceiptDto })
export class SlotWorkflowFinish {}

@Workflow({
  name: "slot-workflow",
  version: "1.0.0",
  flow: [
    start(SlotWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(TakeSlotAction)
      .returns(SlotReceiptDto)
      .toFinish(SlotWorkflowFinish),
  ],
})
export class SlotWorkflow {}

@Application({
  name: "store-bound-leased-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, SlotWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  providers: [HeldLeasesOfLeased, HeldFencedEffectsOfLeased, HungSlotRepository, RecordingLogger],
})
export class StoreBoundLeasedApplication {}
