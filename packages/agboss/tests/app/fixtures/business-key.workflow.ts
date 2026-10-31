import {
  Integer,
  listOf,
  Text,
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  EmptyEnvironment,
  ExecutionContext,
  InMemoryFencedEffectRepository,
  OutboundCalls,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  fencedEffectKeyOf,
  type FencedEffectStatus,
  type OutboundCallOutcomeStatus,
  type Produced,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { MODEL_PROVIDERS } from "../../judges/fixtures/judged.workflow.js";
import { start } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { PaymentGateway, type ChargeReceipt } from "./payment-gateway.js";

/**
 * #508 — an order charged under its business key `order:<id>`, whatever step, execution or thread
 * charges it: a tool the model may call twice, an action through the fenced effect, an action
 * through `OutboundCalls`. A lever freezes an outbound charge before it is sent (in flight).
 */

/** The charges written through the fenced effect, and what each call saw. */
export const ledger = {
  charges: [] as { readonly orderId: string; readonly amountUsd: number }[],
  effects: [] as FencedEffectStatus[],
  outbound: [] as OutboundCallOutcomeStatus[],
  /** How many coming outbound charges freeze before they are sent; the frozen gates. */
  freeze: 0,
  frozen: [] as (() => void)[],
  /** Whether a frozen charge ignores its step's signal. */
  ignoresAbort: false,
};

export function resetLedger(): void {
  ledger.charges.length = 0;
  ledger.effects.length = 0;
  ledger.outbound.length = 0;
  ledger.freeze = 0;
  ledger.frozen.length = 0;
  ledger.ignoresAbort = false;
}

/** Lets every frozen charge go. */
export function letLedgerGo(): void {
  ledger.freeze = 0;
  for (const letGo of ledger.frozen.splice(0)) letGo();
}

export class ChargeRequestDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;

  @Integer({ prompt: "the amount, in dollars" })
  amountUsd!: number;
}

export class ChargeResultDto {
  @Text({ prompt: "the charge's id" })
  chargeId!: string;
}

/** Charges `request` once per order through the fenced effect; another amount is a conflict. */
async function chargedOnce(
  executionContext: ExecutionContext,
  fencedEffects: InMemoryFencedEffectRepository,
  request: ChargeRequestDto,
): Promise<ChargeResultDto> {
  const { orderId, amountUsd } = request;
  const key = fencedEffectKeyOf(executionContext, "charge", {
    businessKey: `order:${orderId}`,
    fingerprint: { amountUsd },
  });
  const outcome = await fencedEffects.saveResultIfAbsent(key, (transaction) => {
    transaction.onCommit(() => ledger.charges.push({ orderId, amountUsd }));
    return { chargeId: `charge-${orderId}-${String(ledger.charges.length + 1)}` };
  });
  ledger.effects.push(outcome.status);
  return outcome.result;
}

@Tool({
  name: "charge-order-tool",
  description: "Charges an order",
  input: ChargeRequestDto,
  output: ChargeResultDto,
  deps: [ExecutionContext, InMemoryFencedEffectRepository],
})
export class ChargeOrderTool implements ToolHandler<ChargeRequestDto, ChargeResultDto> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  run(request: ChargeRequestDto): Promise<ChargeResultDto> {
    return chargedOnce(this.executionContext, this.fencedEffects, request);
  }
}

@Action({
  name: "charge-order-action",
  description: "Charges the order through the fenced effect, under its business key",
  input: { request: ChargeRequestDto },
  output: ChargeResultDto,
  deps: [ExecutionContext, InMemoryFencedEffectRepository],
})
export class ChargeOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: {
    readonly request: Produced<ChargeRequestDto, unknown>;
  }): Promise<ChargeResultDto> {
    return chargedOnce(this.executionContext, this.fencedEffects, input.request.value);
  }
}

/** What the outbound charge needs: the step's context, the service and the provider. */
interface OutboundSite {
  readonly executionContext: ExecutionContext;
  readonly outboundCalls: OutboundCalls;
  readonly paymentGateway: PaymentGateway;
}

/** Waits until let go when the lever says so — or until the call's signal aborts. */
async function frozenWhenAsked(signal: AbortSignal): Promise<void> {
  if (ledger.freeze <= 0) return;
  ledger.freeze -= 1;
  await new Promise<void>((resolve, reject) => {
    ledger.frozen.push(resolve);
    // a client that ignores its signal (#508 review): the send goes on after the step aborted
    if (ledger.ignoresAbort) return;
    signal.addEventListener("abort", () => {
      reject(new Error("the charge was aborted before it was sent"));
    });
  });
}

/** Charges `request` once per order through the provider, as a call that leaves the system. */
async function sentOnce(site: OutboundSite, request: ChargeRequestDto): Promise<ChargeResultDto> {
  const { orderId, amountUsd } = request;
  const key = fencedEffectKeyOf(site.executionContext, "charge", {
    businessKey: `order:${orderId}`,
  });
  const outcome = await site.outboundCalls.send(key, {
    target: "payments",
    operation: "charge",
    request: { orderId, amountUsd },
    send: async (call): Promise<ChargeReceipt> => {
      await frozenWhenAsked(call.signal);
      return site.paymentGateway.charge(call);
    },
    reconcile: (call) => site.paymentGateway.reconcile(call),
  });
  ledger.outbound.push(outcome.status);
  return { chargeId: outcome.result.chargeId };
}

@Tool({
  name: "send-charge-tool",
  description: "Charges an order through the payment provider",
  input: ChargeRequestDto,
  output: ChargeResultDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
export class SendChargeTool implements ToolHandler<ChargeRequestDto, ChargeResultDto> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  run(request: ChargeRequestDto): Promise<ChargeResultDto> {
    const { executionContext, outboundCalls, paymentGateway } = this;
    return sentOnce({ executionContext, outboundCalls, paymentGateway }, request);
  }
}

@Action({
  name: "send-charge-action",
  description: "Charges the order through the payment provider, under its business key",
  input: { request: ChargeRequestDto },
  output: ChargeResultDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
export class SendChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  execute(input: {
    readonly request: Produced<ChargeRequestDto, unknown>;
  }): Promise<ChargeResultDto> {
    const { executionContext, outboundCalls, paymentGateway } = this;
    return sentOnce({ executionContext, outboundCalls, paymentGateway }, input.request.value);
  }
}

@Agent({
  name: "cashier-agent",
  prompt: "Charge the customer's order with charge-order-tool.",
  description: "Charges orders",
  model: "local/llama",
  tools: [ChargeOrderTool, SendChargeTool],
})
export class CashierAgent {}

@WorkflowStart({
  name: "cashier-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class CashierStart {}

@WorkflowFinish({
  name: "cashier-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class CashierFinish {}

@Workflow({
  name: "cashier-workflow",
  version: "1.0.0",
  flow: [
    start(CashierStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CashierAgent)
      .toFinish(CashierFinish),
  ],
  defaults: { models: { temperature: 0 } },
  providers: [PaymentGateway],
})
export class CashierWorkflow {}

@WorkflowStart({
  name: "charge-order-workflow-start",
  description: "An order to charge",
  input: ChargeRequestDto,
})
export class ChargeOrderStart {}

@WorkflowFinish({
  name: "order-charged-workflow-finish",
  description: "The charge",
  output: ChargeResultDto,
})
export class OrderChargedFinish {}

@Workflow({
  name: "charge-order-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeOrderStart)
      .returns(ChargeRequestDto)
      .toAction(ChargeOrderAction)
      .returns(ChargeResultDto)
      .toFinish(OrderChargedFinish),
  ],
})
export class ChargeOrderWorkflow {}

@WorkflowStart({
  name: "send-charge-workflow-start",
  description: "An order to charge through the provider",
  input: ChargeRequestDto,
})
export class SendChargeStart {}

@WorkflowFinish({
  name: "charge-sent-workflow-finish",
  description: "The provider's charge",
  output: ChargeResultDto,
})
export class ChargeSentFinish {}

@Workflow({
  name: "send-charge-workflow",
  version: "1.0.0",
  flow: [
    start(SendChargeStart)
      .returns(ChargeRequestDto)
      .toAction(SendChargeAction)
      .returns(ChargeResultDto)
      .toFinish(ChargeSentFinish),
  ],
  providers: [PaymentGateway],
})
export class SendChargeWorkflow {}

export class ChargeSummaryDto {
  @Text({ prompt: "the charges' ids, in the join's order" })
  chargeIds!: string;
}

@WorkflowStart({
  name: "send-charges-workflow-start",
  description: "Orders to charge at once, one branch each",
  input: listOf(ChargeRequestDto),
})
export class SendChargesStart {}

@WorkflowFinish({
  name: "charges-sent-workflow-finish",
  description: "The charges, in the join's order",
  input: { results: listOf(ChargeResultDto) },
  output: ChargeSummaryDto,
})
export class ChargesSentFinish {
  finish(input: {
    readonly results: readonly Produced<ChargeResultDto, unknown>[];
  }): ChargeSummaryDto {
    return {
      chargeIds: input.results
        .map((result) => result.value.chargeId)
        .join(", "),
    };
  }
}

/** One branch per order of the list, at once: two branches of one tree may charge one order. */
@Workflow({
  name: "send-charges-workflow",
  version: "1.0.0",
  flow: [
    start(SendChargesStart)
      .returns(listOf(ChargeRequestDto))
      .toParallelActions(SendChargeAction, { maxItems: 4 })
      .join()
      .returns(listOf(ChargeResultDto))
      .toFinish(ChargesSentFinish),
  ],
  providers: [PaymentGateway],
})
export class SendChargesWorkflow {}

@Application({
  name: "business-key-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CashierWorkflow, ChargeOrderWorkflow, SendChargeWorkflow, SendChargesWorkflow],
  providers: [...MODEL_PROVIDERS, InMemoryFencedEffectRepository],
  budgets: TEST_BUDGETS,
  observers: [RecoveryLog],
})
export class BusinessKeyApplication {}
