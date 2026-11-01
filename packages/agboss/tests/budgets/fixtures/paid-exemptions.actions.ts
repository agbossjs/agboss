import {
  Action,
  Injectable,
  SpendRecorder,
  type CompensationStartEvent,
  type ExecutionEndEvent,
  type OnCompensationStart,
  type ExecutionErrorEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type Produced,
} from "../../../src/index.js";
import { usd } from "../../../src/units/index.js";
import { OrderDeclinedError, OrderDto, OrderNoteDto, paidSteps } from "./paid-steps.dto.js";

/**
 * #656 — the steps the budget's two exemptions are scoped by: a paid check that declines only when
 * the test says so, a branch that audits the order, and what each execution ended with.
 */

/** Whether the paid check declines; how each execution ended (its finish, or its error's name). */
export const exemptions = {
  declines: false,
  ended: [] as string[],
  /** The key of every undo that started (#675: `<step key>:compensation`). */
  undone: [] as string[],
  /** The undos every failed execution lists (#683): `<node> <reason> <status>`. */
  undos: [] as string[],
};

export function resetExemptions(): void {
  exemptions.declines = false;
  exemptions.ended.length = 0;
  exemptions.undone.length = 0;
  exemptions.undos.length = 0;
}

@Action({
  name: "check-order-action",
  description: "Calls a paid check past the budgets; declines the order when the test says so",
  input: { order: OrderDto },
  output: OrderDto,
  deps: [SpendRecorder],
})
export class CheckOrderAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly order: Produced<OrderDto, unknown> }): Promise<OrderDto> {
    paidSteps.ran.push("check");
    this.spendRecorder.record({ service: "order-api", cost: usd(paidSteps.charge) });
    if (exemptions.declines) return Promise.reject(new OrderDeclinedError("declined"));
    return Promise.resolve(input.order.value);
  }
}

@Action({
  name: "audit-order-action",
  description: "Audits the order",
  input: { order: OrderDto },
  output: OrderNoteDto,
})
export class AuditOrderAction {
  execute(): Promise<OrderNoteDto> {
    paidSteps.ran.push("audit");
    return Promise.resolve({ note: "audit" });
  }
}

@Action({
  name: "tell-order-action",
  description: "Tells the team the budget stopped the order",
  input: { order: OrderDto },
})
export class TellOrderAction {
  execute(): Promise<void> {
    paidSteps.ran.push("tell");
    return Promise.resolve();
  }
}

@Action({
  name: "reject-order-action",
  description: "Rejects the order at once, for free",
  input: { order: OrderDto },
  output: OrderDto,
})
export class RejectOrderAction {
  execute(): Promise<OrderDto> {
    paidSteps.ran.push("reject");
    return Promise.reject(new OrderDeclinedError("rejected"));
  }
}

/** How every root execution ended, on whichever instance ended it; every undo that started. */
@Injectable()
export class ExemptionsLog implements OnExecutionEnd, OnExecutionError, OnCompensationStart {
  onCompensationStart(event: CompensationStartEvent): void {
    exemptions.undone.push(event.step.idempotencyKey);
  }

  onExecutionEnd(event: ExecutionEndEvent): void {
    exemptions.ended.push(event.finish.name);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    exemptions.ended.push(event.error.name);
    for (const undo of event.compensations)
      exemptions.undos.push(`${undo.compensated.nodeId} ${undo.reason} ${undo.status}`);
  }
}
