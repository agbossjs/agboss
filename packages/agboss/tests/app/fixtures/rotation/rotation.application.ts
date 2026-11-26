import { Integer, Text } from "../../../../src/dto/index.js";
import {
  Action,
  DatabaseStorage,
  Idempotency,
  OutboundRecovery,
  SqliteDriver,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  secret,
  env,
  type IdempotencyRunStatus,
  type OutboundCallSendStatus,
  type Tracked,
  Ttl,
} from "../../../../src/index.js";
import { SqliteConnection } from "../../../../src/infrastructure/sqlite/sqlite-connection.js";
import { hours, seconds } from "../../../../src/units/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import { PaymentGateway } from "../payment-gateway.js";

/**
 * #825 — an idempotency key rotated under live business keys: one SQLite file, three applications of
 * one workflow — before the rotation (`idempotencyKeyV1`), during it (`V2`, `V1` the previous) and
 * after it (`V2` alone). An order booked through a fenced effect and charged through `OutboundCalls`
 * under `order:<id>`, each fingerprinted by what it does.
 */

/** What each call saw, in order. */
export const rotation = {
  effects: [] as IdempotencyRunStatus[],
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
  deps: [Idempotency, SqliteConnection],
})
export class BookOrderAction {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly connection: SqliteConnection,
  ) {}

  async execute(input: { readonly order: Tracked<OrderDto> }): Promise<ReceiptDto> {
    const { orderId, amountUsd } = input.order;
    const outcome = await this.idempotency.runOnce({
      name: "book",
      key: `order:${orderId}`,
      fingerprint: { amountUsd },
      ttl: hours(24),
      execute: () => {
        const transaction = this.connection.requireTransaction();
        transaction.exec("CREATE TABLE IF NOT EXISTS rotation_bookings (order_id TEXT)");
        transaction.prepare("INSERT INTO rotation_bookings VALUES (?)").run(orderId);
        return { receipt: `booking-${orderId}` };
      },
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
  deps: [Idempotency, PaymentGateway],
})
export class ChargeOrderAction {
  constructor(
    private readonly idempotency: Idempotency,
    private readonly paymentGateway: PaymentGateway,
  ) {}

  async execute(input: { readonly order: Tracked<OrderDto> }): Promise<ReceiptDto> {
    const { orderId, amountUsd } = input.order;
    const outcome = await this.idempotency.sendOnce({
      name: "charge",
      key: `order:${orderId}`,
      target: "payments",
      operation: "charge",
      request: { orderId, amountUsd },
      timeout: seconds(15),
      ttl: hours(48),
      send: (call) => this.paymentGateway.charge(call),
      recovery: OutboundRecovery.permanentLookup((lookup) => this.paymentGateway.reconcile(lookup)),
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
  historyTtl: Ttl.Forever,
  flow: [onStart(BookOrderStart).toAction(BookOrderAction).toFinish(ReceiptFinish)],
})
export class BookOrderWorkflow {}

@Workflow({
  name: "charge-order-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChargeOrderStart).toAction(ChargeOrderAction).toFinish(ReceiptFinish)],
  providers: [PaymentGateway],
})
export class ChargeOrderWorkflow {}

/** One SQLite file for every instance, and the keys the application's fingerprints are made with. */
const rotatedStorage = (
  name: string,
  idempotencySecret: ReturnType<typeof secret>,
  previousIdempotencySecret?: ReturnType<typeof secret>,
) => {
  @DatabaseStorage({
    name,
    driver: SqliteDriver({ path: env("ROTATION_SQLITE_PATH") }),
    auditLogTtl: hours(24),
    ledgerEntriesTtl: hours(24),
    idempotencySecret,
    ...(previousIdempotencySecret === undefined ? {} : { previousIdempotencySecret }),
  })
  class RotationStorage {}
  return RotationStorage;
};

/** Before the rotation: every fingerprint under `idempotencyKeyV1`. */
@Application({
  name: "rotation-before-application",
  version: "1.0.0",
  workflows: [BookOrderWorkflow, ChargeOrderWorkflow],
  storage: rotatedStorage("rotation-before-storage", secret("ROTATION_IDEMPOTENCY_KEY_V1")),
  budgets: TEST_BUDGETS,
})
export class RotationBeforeApplication {}

/** During it: stored under `idempotencyKeyV2`, compared under both. */
@Application({
  name: "rotation-during-application",
  version: "1.0.0",
  workflows: [BookOrderWorkflow, ChargeOrderWorkflow],
  storage: rotatedStorage(
    "rotation-during-storage",
    secret("ROTATION_IDEMPOTENCY_KEY_V2"),
    secret("ROTATION_IDEMPOTENCY_KEY_V1"),
  ),
  budgets: TEST_BUDGETS,
})
export class RotationDuringApplication {}

/** After it: `idempotencyKeyV1` removed — what is left of it fails closed. */
@Application({
  name: "rotation-after-application",
  version: "1.0.0",
  workflows: [BookOrderWorkflow, ChargeOrderWorkflow],
  storage: rotatedStorage("rotation-after-storage", secret("ROTATION_IDEMPOTENCY_KEY_V2")),
  budgets: TEST_BUDGETS,
})
export class RotationAfterApplication {}

/** The charges on the built-in in-memory stores, under `idempotencyKeyV1` — what a test reads back. */
@Application({
  name: "in-memory-charges-application",
  version: "1.0.0",
  workflows: [ChargeOrderWorkflow],
  budgets: TEST_BUDGETS,
})
export class InMemoryChargesApplication {}
