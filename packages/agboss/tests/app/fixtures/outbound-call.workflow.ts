import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  OutboundCallReconciliation,
  OutboundCallUnreconciledError,
  OutboundCalls,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  fencedEffectKeyOf,
  pii,
  type OnOutboundCall,
  type OutboundCallEvent,
  type OutboundCallOutcomeStatus,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { hours } from "../../../src/units/index.js";
import { start, toFinish } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { PaymentGateway, type ChargeRequest } from "./payment-gateway.js";

/**
 * #505 — an order charged through `OutboundCalls`: the action has no table or retry logic of its
 * own, only `send` (the provider's charge with the call's idempotency key) and `reconcile` (the
 * provider asked by that key). A lever freezes a run before its call (a zombie in its window).
 */

/** What the runs of the action saw: each outcome, the frozen runs. */
export const runs = {
  outcomes: [] as { readonly status: OutboundCallOutcomeStatus; readonly attempt: number }[],
  /** How many coming runs freeze before their call, and after it (before the step's checkpoint). */
  freezeBefore: 0,
  freezeAfter: 0,
  frozen: [] as (() => void)[],
};

export function resetRuns(): void {
  runs.outcomes.length = 0;
  runs.freezeBefore = 0;
  runs.freezeAfter = 0;
  runs.frozen.length = 0;
  heard.events.length = 0;
  heard.throws = false;
}

/** What `onOutboundCall` heard, in order (reset with `resetRuns`); `throws` makes it throw. */
export const heard = { events: [] as OutboundCallEvent[], throws: false };

/** Hears every move of every call that left the system. */
@Injectable()
export class OutboundCallLog implements OnOutboundCall {
  onOutboundCall(event: OutboundCallEvent): void {
    heard.events.push(event);
    if (heard.throws) throw new Error("the observer is broken");
  }
}

/** Lets every frozen run go. */
export function letRunsGo(): void {
  for (const letGo of runs.frozen.splice(0)) letGo();
}

/** Until `count` runs are frozen before their call. */
export async function frozenRuns(count: number): Promise<void> {
  for (let tick = 0; tick < 2000 && runs.frozen.length < count; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));
  if (runs.frozen.length < count) throw new Error(`${String(count)} runs never froze`);
}

/** Waits until let go when the lever says so. */
async function frozenWhen(lever: "freezeBefore" | "freezeAfter"): Promise<void> {
  if (runs[lever] <= 0) return;
  runs[lever] -= 1;
  await new Promise<void>((resolve) => runs.frozen.push(resolve));
}

export class ChargeReceiptDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}

@PiiPolicy({
  name: "email-pii-policy",
  description: "Hides e-mail addresses in what is stored",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class EmailPiiPolicy {}

@Action({
  name: "charge-order-action",
  description: "Charges the order through the payment provider, as a call that leaves the system",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
export class ChargeOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    await frozenWhen("freezeBefore");
    const [orderId = "", email] = input.message.value.text.split(" ");
    const contact = email === undefined ? {} : { email };
    const request: ChargeRequest = { orderId, amountUsd: 10, ...contact };
    const key = fencedEffectKeyOf(this.executionContext, "charge");
    const outcome = await this.outboundCalls.send(key, {
      target: "payments",
      operation: "charge",
      request,
      send: (call) => this.paymentGateway.charge(call),
      reconcile: (call) => this.paymentGateway.reconcile(call),
    });
    runs.outcomes.push({ status: outcome.status, attempt: outcome.attempt });
    await frozenWhen("freezeAfter");
    return { chargeId: outcome.result.chargeId };
  }
}

@Action({
  name: "charge-and-notify-action",
  description: "Charges the order, then mails its receipt: two calls of one step",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
export class ChargeAndNotifyAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    const request: ChargeRequest = { orderId: input.message.value.text, amountUsd: 10 };
    const chargeKey = fencedEffectKeyOf(this.executionContext, "charge");
    const charged = await this.outboundCalls.send(chargeKey, {
      target: "payments",
      operation: "charge",
      request,
      send: (call) => this.paymentGateway.charge(call),
      reconcile: (call) => this.paymentGateway.reconcile(call),
    });
    const mailKey = fencedEffectKeyOf(this.executionContext, "receipt-mail");
    await this.outboundCalls.send(mailKey, {
      target: "mail",
      operation: "send-receipt",
      request: { chargeId: charged.result.chargeId },
      send: () => ({ messageId: "m-1" }),
      reconcile: () =>
        OutboundCallReconciliation.unknown({ reason: "a receipt mail is never left pending here" }),
    });
    return { chargeId: charged.result.chargeId };
  }
}

@WorkflowStart({
  name: "charge-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class ChargeWorkflowStart {}

@WorkflowStart({
  name: "charge-and-notify-workflow-start",
  description: "An order, its receipt mailed",
  input: WorkflowStartTextDto,
})
export class ChargeAndNotifyWorkflowStart {}

@WorkflowFinish({
  name: "charged-workflow-finish",
  description: "The receipt",
  output: ChargeReceiptDto,
})
export class ChargedWorkflowFinish {}

@WorkflowFinish({
  name: "unreconciled-workflow-finish",
  description: "The order, its charge left for an operator",
  output: WorkflowStartTextDto,
})
export class UnreconciledWorkflowFinish {}

@WorkflowFinish({
  name: "notified-workflow-finish",
  description: "The receipt, mailed",
  output: ChargeReceiptDto,
})
export class NotifiedWorkflowFinish {}

@Workflow({
  name: "charge-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargeOrderAction)
      // nobody can say what happened to the charge: the order is set aside for an operator
      .onError(OutboundCallUnreconciledError, toFinish(UnreconciledWorkflowFinish))
      .returns(ChargeReceiptDto)
      .toFinish(ChargedWorkflowFinish),
  ],
  providers: [PaymentGateway],
})
export class ChargeWorkflow {}

@Workflow({
  name: "charge-and-notify-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeAndNotifyWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargeAndNotifyAction)
      .returns(ChargeReceiptDto)
      .toFinish(NotifiedWorkflowFinish),
  ],
  providers: [PaymentGateway],
})
export class ChargeAndNotifyWorkflow {}

/** The calls on the built-in in-memory store: nothing listed. */
@Application({
  name: "outbound-call-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChargeWorkflow, ChargeAndNotifyWorkflow],
  observers: [RecoveryLog, OutboundCallLog],
  budgets: TEST_BUDGETS,
  piiPolicies: [EmailPiiPolicy],
})
export class OutboundCallApplication {}

/** The charge with its PII policy on the workflow, not on the application (#505). */
@Workflow({
  name: "kept-charge-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargeOrderAction)
      .onError(OutboundCallUnreconciledError, toFinish(UnreconciledWorkflowFinish))
      .returns(ChargeReceiptDto)
      .toFinish(ChargedWorkflowFinish),
  ],
  providers: [PaymentGateway],
  piiPolicies: [EmailPiiPolicy],
})
export class KeptChargeWorkflow {}

/**
 * Its root executions kept (#401): their records carry their calls. The e-mail policy is the
 * workflow's only — the application's own mask would leave an address as it is.
 */
@Application({
  name: "kept-outbound-call-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [KeptChargeWorkflow],
  observers: [RecoveryLog, OutboundCallLog],
  budgets: TEST_BUDGETS,
  executionRecordRetention: hours(24),
})
export class KeptOutboundCallApplication {}
