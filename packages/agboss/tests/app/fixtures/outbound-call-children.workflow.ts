import { SilentLogger } from "../../../src/infrastructure/logger.js";
import { SystemClock } from "../../../src/infrastructure/clock.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  ChildPlacement,
  ExecutionContext,
  FencedEffectRepository,
  Idempotency,
  OutboundCallRepository,
  OutboundCallStatus,
  OutboundRecovery,
  Reconciliation,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Ttl,
} from "../../../src/index.js";
import { OutboundMasking } from "../../../src/app/outbound-masking.js";
import { hours, seconds } from "../../../src/units/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { EmailPiiPolicy } from "./outbound-call.workflow.js";
import { PaymentGateway, type ChargeReceipt } from "./payment-gateway.js";

/**
 * #505 — an outbound call made by a child workflow, run in its parent's step (`CurrentProcess`) or
 * queued for any instance (`AnyWorker`): its request is stored masked by the application's PII
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
  deps: [Idempotency, PaymentGateway],
})
export class ChildChargeAction {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: { readonly message: Tracked<WorkflowStartTextDto> }): Promise<ChargedDto> {
    const [orderId = "", email = ""] = input.message.text.split(" ");
    const outcome = await this.idempotency.sendOnce({
      name: "charge",
      target: "payments",
      operation: "charge",
      request: { orderId, amountUsd: 10, email },
      send: (call) => this.paymentGateway.charge(call),
      timeout: seconds(15),
      ttl: hours(48),
      recovery: OutboundRecovery.permanentLookup((call) => this.paymentGateway.reconcile(call)),
    });
    return { chargeId: outcome.result.chargeId };
  }
}

/**
 * Sends through an `Idempotency` whose settings require a mask, in a unit runner's frame — which
 * has none: the call must be refused before anything is stored.
 */
@Action({
  name: "unmasked-charge-action",
  description: "Sends a call where the frame has no mask but the application requires one",
  input: { message: WorkflowStartTextDto },
  deps: [ExecutionContext, FencedEffectRepository, OutboundCallRepository, PaymentGateway],
})
export class UnmaskedChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly effects: FencedEffectRepository,
    private readonly repository: OutboundCallRepository,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(): Promise<void> {
    const masked = new Idempotency(
      this.effects,
      this.repository,
      new OutboundMasking({ requiresMask: true }),
      new SilentLogger(),
      new SystemClock(),
    );
    try {
      await masked.sendOnce({
        name: "charge",
        target: "payments",
        operation: "charge",
        request: { orderId: "order-1", amountUsd: 10, email: "alice@example.com" },
        send: (call) => this.paymentGateway.charge(call),
        timeout: seconds(15),
        ttl: hours(48),
        recovery: OutboundRecovery.permanentLookup<ChargeReceipt>(() =>
          Reconciliation.notExecuted(),
        ),
      });
    } finally {
      const tenantId = this.executionContext.tenant.tenantId;
      const status = OutboundCallStatus.Pending;
      const page = await this.repository.findAllByTenantIdAndStatus({
        tenantId,
        status,
        limit: 1000,
      });
      const pending = page.items;
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
  placement: ChildPlacement.AnyWorker,
  name: "child-charge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChildChargeWorkflowStart)
      .toAction(ChildChargeAction)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(NearChargeWorkflowStart)
      .toWorkflow(ChildChargeWorkflow)
      .toFinish(NearChargedWorkflowFinish),
  ],
})
export class NearChargeWorkflow {}

@Workflow({
  name: "far-charge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FarChargeWorkflowStart)
      .toWorkflow(ChildChargeWorkflow)
      .toFinish(FarChargedWorkflowFinish),
  ],
})
export class FarChargeWorkflow {}

@Application({
  name: "outbound-call-children-application",
  version: "1.0.0",
  workflows: [NearChargeWorkflow, FarChargeWorkflow],
  observers: [RecoveryLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
})
export class OutboundCallChildrenApplication {}
