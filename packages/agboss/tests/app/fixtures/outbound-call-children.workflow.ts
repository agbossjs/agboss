import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  OutboundCallReconciliation,
  OutboundCallRepository,
  OutboundCalls,
  OutboundCallSettings,
  OutboundCallStatus,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  fencedEffectKeyOf,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { EmailPiiPolicy } from "./outbound-call.workflow.js";
import { PaymentGateway } from "./payment-gateway.js";

/**
 * #505 — an outbound call made by a child workflow, run in its parent's step (`ParentInstance`) or
 * queued for any instance (`AnyInstance`): its request is stored masked by the application's PII
 * policies either way. And a step whose frame has no mask while the application lists policies:
 * the call is refused, nothing recorded or sent.
 */

export class ChargedDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}

/** What the fail-closed action found pending in the store after its refused call. */
export const unmasked = { pendingAfter: [] as number[] };

@Action({
  name: "child-charge-action",
  description: "Charges the order from inside a child workflow",
  input: { message: WorkflowStartTextDto },
  output: ChargedDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
export class ChildChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargedDto> {
    const [orderId = "", email = ""] = input.message.value.text.split(" ");
    const key = fencedEffectKeyOf(this.executionContext, "charge");
    const outcome = await this.outboundCalls.send(key, {
      target: "payments",
      operation: "charge",
      request: { orderId, amountUsd: 10, email },
      send: (call) => this.paymentGateway.charge(call),
      reconcile: (call) => this.paymentGateway.reconcile(call),
    });
    return { chargeId: outcome.result.chargeId };
  }
}

/**
 * Sends through an `OutboundCalls` whose settings require a mask, in a unit runner's frame — which
 * has none: the call must be refused before anything is stored.
 */
@Action({
  name: "unmasked-charge-action",
  description: "Sends a call where the frame has no mask but the application requires one",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, OutboundCallRepository, PaymentGateway],
})
export class UnmaskedChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly repository: OutboundCallRepository,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(): Promise<void> {
    const masked = new OutboundCalls(this.repository, new OutboundCallSettings({}, true));
    const key = fencedEffectKeyOf(this.executionContext, "charge");
    try {
      await masked.send(key, {
        target: "payments",
        operation: "charge",
        request: { orderId: "order-1", amountUsd: 10, email: "alice@example.com" },
        send: (call) => this.paymentGateway.charge(call),
        reconcile: () => OutboundCallReconciliation.notSent(),
      });
    } finally {
      const tenantId = this.executionContext.tenant.tenantId;
      const pending = await this.repository.findAllByTenantIdAndStatus(
        tenantId,
        OutboundCallStatus.Pending,
      );
      unmasked.pendingAfter.push(pending.length);
    }
  }
}

@WorkflowStart({
  name: "child-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class ChildChargeWorkflowStart {}

@WorkflowFinish({
  name: "child-charged-workflow-finish",
  description: "Charged",
  output: ChargedDto,
})
export class ChildChargedWorkflowFinish {}

@Workflow({
  name: "child-charge-workflow",
  version: "1.0.0",
  flow: [
    start(ChildChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChildChargeAction)
      .returns(ChargedDto)
      .toFinish(ChildChargedWorkflowFinish),
  ],
  providers: [PaymentGateway],
})
export class ChildChargeWorkflow {}

@WorkflowStart({
  name: "near-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class NearChargeWorkflowStart {}

@WorkflowStart({
  name: "far-charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class FarChargeWorkflowStart {}

@WorkflowFinish({
  name: "near-charged-workflow-finish",
  description: "Charged",
  output: ChargedDto,
})
export class NearChargedWorkflowFinish {}

@WorkflowFinish({ name: "far-charged-workflow-finish", description: "Charged", output: ChargedDto })
export class FarChargedWorkflowFinish {}

@Workflow({
  name: "near-charge-workflow",
  version: "1.0.0",
  flow: [
    start(NearChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(ChildChargeWorkflow)
      .returns(ChargedDto)
      .toFinish(NearChargedWorkflowFinish),
  ],
})
export class NearChargeWorkflow {}

@Workflow({
  name: "far-charge-workflow",
  version: "1.0.0",
  flow: [
    start(FarChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(ChildChargeWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ChargedDto)
      .toFinish(FarChargedWorkflowFinish),
  ],
})
export class FarChargeWorkflow {}

@Application({
  name: "outbound-call-children-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NearChargeWorkflow, FarChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
})
export class OutboundCallChildrenApplication {}
