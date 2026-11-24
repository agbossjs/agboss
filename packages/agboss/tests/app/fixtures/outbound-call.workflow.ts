import { OutboundCallError } from "../../../src/core/error-families/effect-errors.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Idempotency,
  Injectable,
  OutboundRecovery,
  PiiKind,
  PiiPolicy,
  Reconciliation,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OutboundCallEvent,
  type OutboundCallSendStatus,
  type Produced,
  Observer,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { hours, minutes, type Bytes, type Milliseconds } from "../../../src/units/index.js";
import { onStart, toFinish } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { isDeclined, PaymentGateway, type ChargeRequest } from "./payment-gateway.js";
import { untilReached } from "../../helpers/reached.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";

/**
 * #505 — an order charged through `Idempotency.sendOnce`: the action has no table or retry logic of its
 * own, only `send` (the provider's charge with the call's idempotency key) and `recovery` (the
 * provider asked by that key). A lever freezes a run before its call (a zombie in its window).
 */

/** What the runs of the action saw: each outcome, the frozen runs. */
export const runs = {
  outcomes: [] as { readonly status: OutboundCallSendStatus; readonly attempt: number }[],
  /** How many coming runs freeze before their call, and after it (before the step's checkpoint). */
  freezeBefore: 0,
  freezeAfter: 0,
  frozen: [] as (() => void)[],
  /** What the charge is sent with besides its defaults: a `timeout` or a `maxPayloadSize` a test sets. */
  callOptions: {} as { timeout?: Milliseconds; maxPayloadSize?: Bytes },
};

export function resetRuns(): void {
  runs.outcomes.length = 0;
  runs.freezeBefore = 0;
  runs.freezeAfter = 0;
  runs.frozen.length = 0;
  runs.callOptions = {};
  heard.events.length = 0;
  heard.throws = false;
}

/** What `onOutboundCall` heard, in order (reset with `resetRuns`); `throws` makes it throw. */
export const heard = { events: [] as OutboundCallEvent[], throws: false };

/** Hears every move of every call that left the system. */
@Observer()
export class OutboundCallLog {
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
  await untilReached(() => runs.frozen.length >= count, `${String(count)} runs never froze`);
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
  rules: [PiiKind.Email.mask()],
})
export class EmailPiiPolicy {}

@Action({
  name: "charge-order-action",
  description: "Charges the order through the payment provider, as a call that leaves the system",
  input: { message: WorkflowStartTextDto },
  output: ChargeReceiptDto,
  deps: [Idempotency, PaymentGateway],
})
export class ChargeOrderAction {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    await frozenWhen("freezeBefore");
    const [orderId = "", email] = input.message.value.text.split(" ");
    const contact = email === undefined ? {} : { email };
    const request: ChargeRequest = { orderId, amountUsd: 10, ...contact };
    const outcome = await this.idempotency.sendOnce({
      name: "charge",
      target: "payments",
      operation: "charge",
      request,
      send: (call) => this.paymentGateway.charge(call),
      timeout: minutes(2),
      ttl: hours(48),
      ...runs.callOptions,
      recovery: OutboundRecovery.permanentLookup((call) => this.paymentGateway.reconcile(call)),
      // #657: a decline is the provider's definite answer — anything else is of unknown outcome
      isDefiniteFailure: isDeclined,
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
  deps: [Idempotency, PaymentGateway],
})
export class ChargeAndNotifyAction {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ChargeReceiptDto> {
    const request: ChargeRequest = { orderId: input.message.value.text, amountUsd: 10 };
    const charged = await this.idempotency.sendOnce({
      name: "charge",
      target: "payments",
      operation: "charge",
      request,
      send: (call) => this.paymentGateway.charge(call),
      timeout: minutes(2),
      ttl: hours(48),
      recovery: OutboundRecovery.permanentLookup((call) => this.paymentGateway.reconcile(call)),
      // #657: a decline is the provider's definite answer — anything else is of unknown outcome
      isDefiniteFailure: isDeclined,
    });
    await this.idempotency.sendOnce({
      name: "receipt-mail",
      target: "mail",
      operation: "send-receipt",
      request: { chargeId: charged.result.chargeId },
      send: () => ({ messageId: "m-1" }),
      timeout: minutes(2),
      ttl: hours(48),
      recovery: OutboundRecovery.permanentLookup<{ messageId: "m-1" }>(() =>
        Reconciliation.unknown("a receipt mail is never left pending here"),
      ),
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
    onStart(ChargeWorkflowStart)
      .toAction(ChargeOrderAction)
      // nobody can say what happened to the charge: the order is set aside for an operator
      .onError(OutboundCallError.Unreconciled, toFinish(UnreconciledWorkflowFinish))
      .toFinish(ChargedWorkflowFinish),
  ],
  providers: [PaymentGateway],
})
export class ChargeWorkflow {}

@Workflow({
  name: "charge-and-notify-workflow",
  version: "1.0.0",
  flow: [
    onStart(ChargeAndNotifyWorkflowStart)
      .toAction(ChargeAndNotifyAction)
      .toFinish(NotifiedWorkflowFinish),
  ],
  providers: [PaymentGateway],
})
export class ChargeAndNotifyWorkflow {}

/** The calls on the built-in in-memory store: nothing listed. */
@Application({
  name: "outbound-call-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
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
    onStart(ChargeWorkflowStart)
      .toAction(ChargeOrderAction)
      .onError(OutboundCallError.Unreconciled, toFinish(UnreconciledWorkflowFinish))
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
  environment: IdempotencyKeyEnvironment,
  workflows: [KeptChargeWorkflow],
  observers: [RecoveryLog, OutboundCallLog],
  budgets: TEST_BUDGETS,
  retention: { executionRecords: hours(24) },
})
export class KeptOutboundCallApplication {}
