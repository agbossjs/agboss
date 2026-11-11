import { Integer, Text } from "../../../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  NotSentTrust,
  OutboundCalls,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  effectKeyOf,
  type FencedEffectStatus,
  type OutboundCallSendStatus,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
import { PaymentGateway } from "../payment-gateway.js";
import { RotationEnvironment } from "./environments/app.environment.js";

/**
 * #825 — an idempotency key rotated under live business keys: one SQLite file, three applications of
 * one workflow — before the rotation (`idempotencyKeyV1`), during it (`V2`, `V1` the previous) and
 * after it (`V2` alone). An order booked through a fenced effect and charged through `OutboundCalls`
 * under `order:<id>`, each fingerprinted by what it does.
 */

/** What each call saw, in order. */
export const rotation = {
  effects: [] as FencedEffectStatus[],
  calls: [] as OutboundCallSendStatus[],
  /** The business rows the bookings wrote (committed). */
  booked: [] as string[],
};

export function resetRotation(): void {
  rotation.effects.length = 0;
  rotation.calls.length = 0;
  rotation.booked.length = 0;
}

export class OrderDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;

  @Integer({ prompt: "the amount, in dollars" })
  amountUsd!: number;
}

export class ReceiptDto {
  @Text({ prompt: "the receipt" })
  receipt!: string;
}

@Action({
  name: "book-order-action",
  description: "Books the order once, in a fenced effect fingerprinted by its amount",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [ExecutionContext, SqliteFencedEffectRepository],
})
export class BookOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: SqliteFencedEffectRepository,
  ) {}

  async execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const { orderId, amountUsd } = input.order.value;
    const key = effectKeyOf(this.executionContext, "book", {
      businessKey: `order:${orderId}`,
      fingerprint: { amountUsd },
    });
    const outcome = await this.fencedEffects.runOnce(key, (database) => {
      database.exec("CREATE TABLE IF NOT EXISTS rotation_bookings (order_id TEXT)");
      database.prepare("INSERT INTO rotation_bookings VALUES (?)").run(orderId);
      return { receipt: `booking-${orderId}` };
    });
    rotation.effects.push(outcome.status);
    rotation.booked.push(orderId);
    return outcome.result;
  }
}

@Action({
  name: "charge-order-action",
  description: "Charges the order once, through the provider, fingerprinted by its request",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [ExecutionContext, OutboundCalls, PaymentGateway],
})
export class ChargeOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const { orderId, amountUsd } = input.order.value;
    const key = effectKeyOf(this.executionContext, "charge", { businessKey: `order:${orderId}` });
    const outcome = await this.outboundCalls.send(key, {
      target: "payments",
      operation: "charge",
      request: { orderId, amountUsd },
      send: (call) => this.paymentGateway.charge(call),
      notSent: { trust: NotSentTrust.Lookup },
      reconcile: (lookup) => this.paymentGateway.reconcile(lookup),
    });
    rotation.calls.push(outcome.status);
    return { receipt: outcome.result.chargeId };
  }
}

@WorkflowStart({
  name: "book-order-workflow-start",
  description: "An order to book",
  input: OrderDto,
})
export class BookOrderStart {}

@WorkflowStart({
  name: "charge-order-workflow-start",
  description: "An order to charge",
  input: OrderDto,
})
export class ChargeOrderStart {}

@WorkflowFinish({ name: "receipt-workflow-finish", description: "The receipt", output: ReceiptDto })
export class ReceiptFinish {}

@Workflow({
  name: "book-order-workflow",
  version: "1.0.0",
  flow: [
    start(BookOrderStart)
      .returns(OrderDto)
      .toAction(BookOrderAction)
      .returns(ReceiptDto)
      .toFinish(ReceiptFinish),
  ],
})
export class BookOrderWorkflow {}

@Workflow({
  name: "charge-order-workflow",
  version: "1.0.0",
  flow: [
    start(ChargeOrderStart)
      .returns(OrderDto)
      .toAction(ChargeOrderAction)
      .returns(ReceiptDto)
      .toFinish(ReceiptFinish),
  ],
  providers: [PaymentGateway],
})
export class ChargeOrderWorkflow {}

const STORES = [
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
];

/** Before the rotation: every fingerprint under `idempotencyKeyV1`. */
@Application({
  name: "rotation-before-application",
  version: "1.0.0",
  environment: RotationEnvironment,
  idempotencyKeyField: "idempotencyKeyV1",
  workflows: [BookOrderWorkflow, ChargeOrderWorkflow],
  providers: STORES,
  budgets: TEST_BUDGETS,
})
export class RotationBeforeApplication {}

/** During it: stored under `idempotencyKeyV2`, compared under both. */
@Application({
  name: "rotation-during-application",
  version: "1.0.0",
  environment: RotationEnvironment,
  idempotencyKeyField: "idempotencyKeyV2",
  previousIdempotencyKeyField: "idempotencyKeyV1",
  workflows: [BookOrderWorkflow, ChargeOrderWorkflow],
  providers: STORES,
  budgets: TEST_BUDGETS,
})
export class RotationDuringApplication {}

/** After it: `idempotencyKeyV1` removed — what is left of it fails closed. */
@Application({
  name: "rotation-after-application",
  version: "1.0.0",
  environment: RotationEnvironment,
  idempotencyKeyField: "idempotencyKeyV2",
  workflows: [BookOrderWorkflow, ChargeOrderWorkflow],
  providers: STORES,
  budgets: TEST_BUDGETS,
})
export class RotationAfterApplication {}

/** The charges on the built-in in-memory stores, under `idempotencyKeyV1` — what a test reads back. */
@Application({
  name: "in-memory-charges-application",
  version: "1.0.0",
  environment: RotationEnvironment,
  idempotencyKeyField: "idempotencyKeyV1",
  workflows: [ChargeOrderWorkflow],
  budgets: TEST_BUDGETS,
})
export class InMemoryChargesApplication {}
