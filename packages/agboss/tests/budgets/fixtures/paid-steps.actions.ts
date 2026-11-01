import {
  Action,
  ExecutionContext,
  Injectable,
  listOf,
  oneOf,
  SpendRecorder,
  variant,
  type ExecutionStartEvent,
  type OnExecutionStart,
  type Produced,
} from "../../../src/index.js";
import { usd } from "../../../src/units/index.js";
import { OrderDeclinedError, OrderDto, OrderNoteDto, paidSteps } from "./paid-steps.dto.js";

/**
 * #634 — steps that pay a service: an overspend that exhausts the budgets, and the steps that
 * may follow it, each writing what it did into `paidSteps.ran`.
 */

@Action({
  name: "refund-order-action",
  description: "Refunds the order's charge",
  input: { order: OrderDto },
})
export class RefundOrderAction {
  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<void> {
    paidSteps.ran.push(`refund ${input.order.value.orderId}`);
    return Promise.resolve();
  }
}

@Action({
  name: "book-order-action",
  description: "Books the order (refunded by its undo)",
  input: { order: OrderDto },
  compensateWith: RefundOrderAction,
})
export class BookOrderAction {
  execute(): Promise<void> {
    paidSteps.ran.push("book");
    return Promise.resolve();
  }
}

/** The paid service's call that exhausts the budgets (`paidSteps.charge` USD). */
const overspend = (spendRecorder: SpendRecorder, what: string): void => {
  paidSteps.ran.push(what);
  spendRecorder.record({ service: "order-api", cost: usd(paidSteps.charge) });
};

@Action({
  name: "overspend-order-action",
  description: "Calls a paid service that costs more than the budgets allow",
  input: { order: OrderDto },
  output: OrderDto,
  deps: [SpendRecorder],
})
export class OverspendOrderAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<OrderDto> {
    overspend(this.spendRecorder, "charge");
    return Promise.resolve(input.order.value);
  }
}

@Action({
  name: "overspend-orders-action",
  description: "Calls a paid service for every order, past the budgets",
  input: { orders: listOf(OrderDto) },
  output: listOf(OrderDto),
  deps: [SpendRecorder],
})
export class OverspendOrdersAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: {
    readonly orders: readonly Produced<OrderDto, unknown>[];
  }): Promise<readonly OrderDto[]> {
    overspend(this.spendRecorder, "charge all");
    return Promise.resolve(input.orders.map((order) => order.value));
  }
}

@Action({
  name: "decline-order-action",
  description: "Calls a paid check past the budgets, then declines the order",
  input: { order: OrderDto },
  output: OrderDto,
  deps: [SpendRecorder],
})
export class DeclineOrderAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(): Promise<OrderDto> {
    overspend(this.spendRecorder, "decline");
    return Promise.reject(new OrderDeclinedError("the order was declined"));
  }
}

/** A recursion's step: pays past the budgets on the first level, goes one level deeper from it. */
@Action({
  name: "level-order-action",
  description: "Pays on the first level, which goes one level deeper; the next level notes it",
  input: { order: OrderDto },
  output: oneOf(OrderDto, OrderNoteDto),
  deps: [ExecutionContext, SpendRecorder],
})
export class LevelOrderAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly spendRecorder: SpendRecorder,
  ) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<unknown> {
    const { depth } = this.executionContext;
    if (depth > 1) {
      paidSteps.ran.push(`level ${String(depth)}`);
      return Promise.resolve(variant(OrderNoteDto, { note: "deeper" }));
    }
    overspend(this.spendRecorder, "level 1");
    return Promise.resolve(variant(OrderDto, input.order.value));
  }
}

/** A step that writes what it is (`note`, `notify`) in `paidSteps.ran`. */
const noted = (what: string): Promise<OrderNoteDto> => {
  paidSteps.ran.push(what);
  return Promise.resolve({ note: what });
};

@Action({
  name: "note-order-action",
  description: "Notes the order",
  input: { order: OrderDto },
  output: OrderNoteDto,
})
export class NoteOrderAction {
  execute(): Promise<OrderNoteDto> {
    return noted("note");
  }
}

@Action({
  name: "memo-order-action",
  description: "Writes a memo of the order",
  input: { order: OrderDto },
})
export class MemoOrderAction {
  execute(): Promise<void> {
    paidSteps.ran.push("memo");
    return Promise.resolve();
  }
}

/** A branch's paid call past the budgets: it gives nothing, so its siblings' values stand. */
@Action({
  name: "charge-order-action",
  description: "Calls a paid service past the budgets",
  input: { order: OrderDto },
  deps: [SpendRecorder],
})
export class ChargeOrderAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(): Promise<void> {
    overspend(this.spendRecorder, "charge");
    return Promise.resolve();
  }
}

@Action({
  name: "notify-order-action",
  description: "Tells the team about the order",
  input: { order: OrderDto },
  output: OrderNoteDto,
})
export class NotifyOrderAction {
  execute(): Promise<OrderNoteDto> {
    return noted("notify");
  }
}

@Action({
  name: "hold-order-action",
  description: "Waits until the test lets it go",
  input: { order: OrderDto },
  output: OrderDto,
})
export class HoldOrderAction {
  async execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<OrderDto> {
    paidSteps.ran.push("hold");
    await paidSteps.held;
    return input.order.value;
  }
}

/** Every execution started: a child or a level refused before it starts is never here. */
@Injectable()
export class PaidStepsLog implements OnExecutionStart {
  onExecutionStart(event: ExecutionStartEvent): void {
    paidSteps.started.push(event.workflow.name);
  }
}
