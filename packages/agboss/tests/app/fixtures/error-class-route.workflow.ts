import {
  Action,
  ApplicationContext,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start, toFinish } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { BookingDto, BookItemAction, ConfirmBookingAction } from "./finished-undo.workflow.js";

/**
 * #598 — a parent's side path on its child's own error class, taken the same way on every holder:
 * a payment declined in a child (on the parent's instance or on any, with or without an undo) is
 * routed to the parent's `.onError(PaymentDeclinedError, …)` whether the instance that saw it routes
 * it, or the one that took the tree over after the failure was announced. The declining step waits
 * at a gate the test opens; a `…-flaky` item declines its first run only.
 */

/** The child's own error class: no `static code`, so it is caught by its class name. */
export class PaymentDeclinedError extends Error {
  override name = "PaymentDeclinedError";
}

/** What ran and what was heard (reset with `resetRoutes`), and the test's hook. */
export const routeSeen = {
  runs: [] as string[],
  finishes: [] as { workflow: string; finish: string; instanceId: string }[],
  errors: [] as { workflow: string; error: string; instanceId: string; isChild: boolean }[],
  onChildError: undefined as ((instanceId?: string) => void) | undefined,
  gate: { opened: Promise.resolve(), open: (): void => undefined },
};

export function resetRoutes(): void {
  routeSeen.runs.length = 0;
  routeSeen.finishes.length = 0;
  routeSeen.errors.length = 0;
  routeSeen.onChildError = undefined;
  routeSeen.gate.opened = new Promise((resolve) => {
    routeSeen.gate.open = resolve;
  });
}

@Action({
  name: "declinable-charge-action",
  description: "Charges the item; an item to fail is declined, a flaky one its first time only",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [ExecutionContext],
})
export class DeclinableChargeAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  async execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    const { name, outcome } = input.item.value;
    routeSeen.runs.push(`${name} on ${this.executionContext.tenant.application.instanceId}`);
    await routeSeen.gate.opened;
    const isFirst = routeSeen.runs.filter((run) => run.startsWith(`${name} on`)).length === 1;
    if (outcome === "fail" || (name.endsWith("-flaky") && isFirst))
      throw new PaymentDeclinedError(`the card for ${name} was declined`);
    return { name };
  }
}

@WorkflowStart({ name: "decline-check-workflow-start", description: "An item", input: ItemDto })
export class DeclineCheckWorkflowStart {}

@WorkflowFinish({ name: "decline-checked-workflow-finish", description: "Charged", output: ItemResultDto })
export class DeclineCheckedWorkflowFinish {}

@Workflow({
  name: "decline-check-workflow",
  version: "1.0.0",
  flow: [
    start(DeclineCheckWorkflowStart)
      .returns(ItemDto)
      .toAction(DeclinableChargeAction)
      .returns(ItemResultDto)
      .toFinish(DeclineCheckedWorkflowFinish),
  ],
})
export class DeclineCheckWorkflow {}

@WorkflowStart({ name: "decline-booking-workflow-start", description: "An item", input: ItemDto })
export class DeclineBookingWorkflowStart {}

@WorkflowFinish({ name: "decline-booked-workflow-finish", description: "Booked, charged", output: ItemResultDto })
export class DeclineBookedWorkflowFinish {}

/** The child with an undo: booked first (undone by a cancel), then charged. */
@Workflow({
  name: "decline-booking-workflow",
  version: "1.0.0",
  flow: [
    start(DeclineBookingWorkflowStart)
      .returns(ItemDto)
      .toAction(BookItemAction)
      .returns(BookingDto)
      .toAction(DeclinableChargeAction)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(DeclineBookedWorkflowFinish),
  ],
})
export class DeclineBookingWorkflow {}

@WorkflowFinish({ name: "declined-workflow-finish", description: "The declined item", output: ItemDto })
export class DeclinedWorkflowFinish {}

@WorkflowFinish({ name: "paid-workflow-finish", description: "The item paid", output: ItemResultDto })
export class PaidWorkflowFinish {}

/** A parent of `child` placed `placement`, its side path on the child's own error class. */
function parentOf(name: string, child: object, placement: ChildPlacement) {
  @WorkflowStart({ name: `${name}-workflow-start`, description: "An item to pay", input: ItemDto })
  class ParentStart {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [
      start(ParentStart)
        .returns(ItemDto)
        .toWorkflow(child as typeof DeclineCheckWorkflow, { placement })
        .onError(PaymentDeclinedError, toFinish(DeclinedWorkflowFinish))
        .returns(ItemResultDto)
        .toFinish(PaidWorkflowFinish),
    ],
  })
  class ParentWorkflow {}
  return { start: ParentStart, workflow: ParentWorkflow };
}

export const PARENTS = [
  { child: "ParentInstance", ...parentOf("pay-local", DeclineCheckWorkflow, ChildPlacement.ParentInstance) },
  { child: "AnyInstance", ...parentOf("pay-remote", DeclineCheckWorkflow, ChildPlacement.AnyInstance) },
  { child: "ParentInstance with an undo", ...parentOf("book-local", DeclineBookingWorkflow, ChildPlacement.ParentInstance) },
  { child: "AnyInstance with an undo", ...parentOf("book-remote", DeclineBookingWorkflow, ChildPlacement.AnyInstance) },
] as const;

const CHILDREN: ReadonlySet<string> = new Set(["decline-check-workflow", "decline-booking-workflow"]);

/** Every root finish and every failure, with the instance that announced it. */
@Injectable({ deps: [ApplicationContext] })
export class RouteLog implements OnExecutionEnd, OnExecutionError {
  constructor(private readonly applicationContext: ApplicationContext) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    if (CHILDREN.has(event.workflow.name)) return;
    const { instanceId } = this.applicationContext;
    const { workflow, finish } = event;
    routeSeen.finishes.push({ workflow: workflow.name, finish: finish.name, instanceId });
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    const { instanceId } = this.applicationContext;
    const isChild = CHILDREN.has(event.workflow.name);
    const { workflow, error } = event;
    routeSeen.errors.push({ workflow: workflow.name, error: error.name, instanceId, isChild });
    if (isChild) routeSeen.onChildError?.(instanceId);
  }
}

@Application({
  name: "error-class-route-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: PARENTS.map((parent) => parent.workflow),
  observers: [RouteLog],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class ErrorClassRouteApplication {}
