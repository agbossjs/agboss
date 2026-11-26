import {
  Action,
  ApplicationContext,
  ChildPlacement,
  ExecutionContext,
  Observer,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type Tracked,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import type { Class } from "../../../src/components/injection.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toFinish } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { BookItemAction, ConfirmBookingAction } from "./finished-undo.workflow.js";

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

  async execute(input: { readonly item: Tracked<ItemDto> }): Promise<ItemResultDto> {
    const { name, outcome } = input.item;
    routeSeen.runs.push(`${name} on ${this.executionContext.tenant.application.instanceId}`);
    await routeSeen.gate.opened;
    const isFirst = routeSeen.runs.filter((run) => run.startsWith(`${name} on`)).length === 1;
    if (outcome === "fail" || (name.endsWith("-flaky") && isFirst))
      throw new PaymentDeclinedError(`the card for ${name} was declined`);
    return { name };
  }
}

/** The child that charges once; `where` names it, `placement` is where it runs. */
function declineCheckOf(where: string, placement: ChildPlacement): Class {
  @WorkflowStart({
    name: `decline-check-${where}-workflow-start`,
    description: "An item",
    input: ItemDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `decline-checked-${where}-workflow-finish`,
    description: "Charged",
    output: ItemResultDto,
  })
  class Finish {}
  @Workflow({
    name: `decline-check-${where}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    placement,
    flow: [onStart(Start).toAction(DeclinableChargeAction).toFinish(Finish)],
  })
  class Check {}
  return Check;
}

/** The child with an undo: booked first (undone by a cancel), then charged. */
function declineBookingOf(where: string, placement: ChildPlacement): Class {
  @WorkflowStart({
    name: `decline-booking-${where}-workflow-start`,
    description: "An item",
    input: ItemDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `decline-booked-${where}-workflow-finish`,
    description: "Booked, charged",
    output: ItemResultDto,
  })
  class Finish {}
  @Workflow({
    name: `decline-booking-${where}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    placement,
    flow: [
      onStart(Start)
        .toAction(BookItemAction)
        .toAction(DeclinableChargeAction)
        .toAction(ConfirmBookingAction)
        .toFinish(Finish),
    ],
  })
  class Booking {}
  return Booking;
}

@WorkflowFinish({
  name: "declined-workflow-finish",
  description: "The declined item",
  output: ItemDto,
})
export class DeclinedWorkflowFinish {}

@WorkflowFinish({
  name: "paid-workflow-finish",
  description: "The item paid",
  output: ItemResultDto,
})
export class PaidWorkflowFinish {}

/** A parent of `child`, its side path on the child's own error class. */
function parentOf(name: string, child: Class) {
  @WorkflowStart({ name: `${name}-workflow-start`, description: "An item to pay", input: ItemDto })
  class ParentStart {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(ParentStart)
        .toWorkflow(child)
        .onError(PaymentDeclinedError, toFinish(DeclinedWorkflowFinish))
        .toFinish(PaidWorkflowFinish),
    ],
  })
  class ParentWorkflow {}
  return { start: ParentStart, workflow: ParentWorkflow };
}

export const PARENTS = [
  {
    child: "CurrentProcess",
    ...parentOf("pay-local", declineCheckOf("local", ChildPlacement.CurrentProcess)),
  },
  {
    child: "AnyWorker",
    ...parentOf("pay-remote", declineCheckOf("remote", ChildPlacement.AnyWorker)),
  },
  {
    child: "CurrentProcess with an undo",
    ...parentOf("book-local", declineBookingOf("local", ChildPlacement.CurrentProcess)),
  },
  {
    child: "AnyWorker with an undo",
    ...parentOf("book-remote", declineBookingOf("remote", ChildPlacement.AnyWorker)),
  },
] as const;

const CHILDREN: ReadonlySet<string> = new Set([
  "decline-check-local-workflow",
  "decline-check-remote-workflow",
  "decline-booking-local-workflow",
  "decline-booking-remote-workflow",
]);

/** Every root finish and every failure, with the instance that announced it. */
@Observer({ deps: [ApplicationContext] })
export class RouteLog {
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
  workflows: PARENTS.map((parent) => parent.workflow),
  observers: [RouteLog],
  providers: [RecordingLogger],
  budgets: TEST_BUDGETS,
})
export class ErrorClassRouteApplication {}
