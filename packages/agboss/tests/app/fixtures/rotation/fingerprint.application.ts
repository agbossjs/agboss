import { effectKeyForTesting } from "../../../../src/testing/contracts/effect-key.js";
import {
  Action,
  ExecutionContext,
  FingerprintPolicy,
  InMemoryFencedEffectRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  effectKeyOf,
  type EffectKey,
  type FencedEffectStatus,
  type Produced,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";
import { RotationEnvironment } from "./environments/app.environment.js";
import { OrderDto, ReceiptDto } from "./rotation.application.js";

/**
 * #825 AC1 — two fenced effects under one business key (`order:<id>`, effect `book`) that do other
 * work: a charge and a refund. Each fingerprints what it does, so the second is a conflict, never a
 * replay of the first; `FingerprintPolicy.None` replays by choice; a key without either — a
 * JavaScript caller, a cast — is refused before anything runs.
 */

export const books = {
  statuses: [] as FencedEffectStatus[],
  /** What the writes did, in the order they ran (a replay runs none). */
  ran: [] as string[],
};

export function resetBooks(): void {
  books.statuses.length = 0;
  books.ran.length = 0;
}

/** Books `kind` of the order under its business key, with `key`'s fingerprint decision. */
async function booked(
  fencedEffects: InMemoryFencedEffectRepository,
  key: EffectKey,
  kind: string,
): Promise<ReceiptDto> {
  const outcome = await fencedEffects.runOnce(key, () => {
    books.ran.push(kind);
    return { receipt: `${kind}-${String(books.ran.length)}` };
  });
  books.statuses.push(outcome.status);
  return outcome.result;
}

const DEPS = [ExecutionContext, InMemoryFencedEffectRepository] as const;

@Action({
  name: "book-charge-action",
  description: "Books a charge of the order, fingerprinted by what it does",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [...DEPS],
})
export class BookChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const { orderId, amountUsd } = input.order.value;
    const key = effectKeyOf(this.executionContext, "book", {
      businessKey: `order:${orderId}`,
      fingerprint: { kind: "charge", amountUsd },
    });
    return booked(this.fencedEffects, key, "charge");
  }
}

@Action({
  name: "book-refund-action",
  description: "Books a refund of the order under the same business key: other work",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [...DEPS],
})
export class BookRefundAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const { orderId, amountUsd } = input.order.value;
    const key = effectKeyOf(this.executionContext, "book", {
      businessKey: `order:${orderId}`,
      fingerprint: { kind: "refund", amountUsd },
    });
    return booked(this.fencedEffects, key, "refund");
  }
}

@Action({
  name: "book-event-action",
  description: "Applies the order's event once by its id: the same work by construction",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [...DEPS],
})
export class BookEventAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const key = effectKeyOf(this.executionContext, "book", {
      businessKey: `event:${input.order.value.orderId}`,
      fingerprintPolicy: FingerprintPolicy.None,
    });
    return booked(this.fencedEffects, key, `event-${String(input.order.value.amountUsd)}`);
  }
}

/** A key without a fingerprint decision, as a JavaScript caller — or a cast — hands it over. */
const unsaidKeyOf = (executionContext: ExecutionContext, orderId: string): EffectKey =>
  effectKeyForTesting(effectKeyOf(executionContext, "book", { businessKey: `order:${orderId}` }));

@Action({
  name: "book-unsaid-charge-action",
  description: "Books a charge under a business key that says nothing of what it does",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [...DEPS],
})
export class BookUnsaidChargeAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const key = unsaidKeyOf(this.executionContext, input.order.value.orderId);
    return booked(this.fencedEffects, key, "charge");
  }
}

@Action({
  name: "book-unsaid-refund-action",
  description: "Books a refund under the same business key, saying nothing of what it does",
  input: { order: OrderDto },
  output: ReceiptDto,
  deps: [...DEPS],
})
export class BookUnsaidRefundAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<ReceiptDto> {
    const key = unsaidKeyOf(this.executionContext, input.order.value.orderId);
    return booked(this.fencedEffects, key, "refund");
  }
}

const ACTIONS = [
  ["charge", BookChargeAction],
  ["refund", BookRefundAction],
  ["event", BookEventAction],
  ["unsaid-charge", BookUnsaidChargeAction],
  ["unsaid-refund", BookUnsaidRefundAction],
] as const;

@WorkflowFinish({ name: "booked-workflow-finish", description: "The receipt", output: ReceiptDto })
export class BookedFinish {}

/** One start and one workflow per action. */
function bookingWorkflow(kind: string, action: (typeof ACTIONS)[number][1]) {
  @WorkflowStart({
    name: `book-${kind}-workflow-start`,
    description: `An order to book (${kind})`,
    input: OrderDto,
  })
  class BookStart {}

  @Workflow({
    name: `book-${kind}-workflow`,
    version: "1.0.0",
    flow: [
      start(BookStart)
        .returns(OrderDto)
        .toAction(action)
        .returns(ReceiptDto)
        .toFinish(BookedFinish),
    ],
  })
  class BookWorkflow {}

  return { start: BookStart, workflow: BookWorkflow };
}

export const BOOKINGS = Object.fromEntries(
  ACTIONS.map(([kind, action]) => [kind, bookingWorkflow(kind, action)]),
) as Record<(typeof ACTIONS)[number][0], ReturnType<typeof bookingWorkflow>>;

@Application({
  name: "fingerprint-application",
  version: "1.0.0",
  environment: RotationEnvironment,
  idempotencyKeyField: "idempotencyKeyV1",
  workflows: Object.values(BOOKINGS).map((booking) => booking.workflow),
  providers: [InMemoryFencedEffectRepository],
  budgets: TEST_BUDGETS,
})
export class FingerprintApplication {}
