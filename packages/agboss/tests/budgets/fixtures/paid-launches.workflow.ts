import {
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Action,
  Ttl,
} from "../../../src/index.js";
import { onStart, toAction, toWorkflow, toFinish } from "../../helpers/flow.js";
import {
  ChargeOrderAction,
  HoldOrderAction,
  LevelOrderAction,
  MemoOrderAction,
  NoteOrderAction,
  OverspendOrderAction,
  OverspendOrdersAction,
} from "./paid-steps.actions.js";
import { OrderDto, OrderNoteDto } from "./paid-steps.dto.js";

/**
 * #634 — after an overspend, a step that launches: a child workflow, one child per item, a level of
 * a recursion, a parallel launch of two actions; two branches of which the first spends the last of
 * the budget; and a step held until the test lets it go (another instance spends meanwhile).
 */

const startOf = (name: string) =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "One order", input: OrderDto });
const finishOf = (name: string) =>
  WorkflowFinish({ name: `${name}-workflow-finish`, description: "Noted", output: OrderNoteDto });

@startOf("note-child")
export class NoteChildWorkflowStart {}
@finishOf("note-child")
export class NoteChildWorkflowFinish {}

/** The child: notes its order. */
@Workflow({
  name: "note-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(NoteChildWorkflowStart).toAction(NoteOrderAction).toFinish(NoteChildWorkflowFinish),
  ],
})
export class NoteChildWorkflow {}

@startOf("paid-child")
export class PaidChildWorkflowStart {}
@finishOf("paid-child")
export class PaidChildWorkflowFinish {}

@Workflow({
  name: "paid-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidChildWorkflowStart)
      .toAction(OverspendOrderAction)
      .toWorkflow(NoteChildWorkflow)
      .toFinish(PaidChildWorkflowFinish),
  ],
})
export class PaidChildWorkflow {}

@WorkflowStart({
  name: "paid-items-workflow-start",
  description: "Orders",
  input: listOf(OrderDto),
})
export class PaidItemsWorkflowStart {}

@Action({
  name: "paid-items-action",
  description: "Every order's note",
  input: { notes: listOf(OrderNoteDto) },
  output: OrderNoteDto,
})
export class PaidItemsAction {
  async execute(input: {
    readonly notes: readonly Tracked<OrderNoteDto>[];
  }): Promise<OrderNoteDto> {
    return {
      note: input.notes.map((note) => note.note).join("; "),
    };
  }
}

@WorkflowFinish({
  name: "paid-items-workflow-finish",
  description: "Every order's note",
  output: OrderNoteDto,
})
export class PaidItemsWorkflowFinish {}

/** Charged past the budgets for every order, then one child per order. */
@Workflow({
  name: "paid-items-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidItemsWorkflowStart)
      .toAction(OverspendOrdersAction)
      .forEachItem(toWorkflow(NoteChildWorkflow), { takeFirst: 3 })
      .join()
      .toAction(PaidItemsAction)
      .toFinish(PaidItemsWorkflowFinish),
  ],
})
export class PaidItemsWorkflow {}

@startOf("paid-level")
export class PaidLevelWorkflowStart {}
@finishOf("paid-level")
export class PaidLevelWorkflowFinish {}

/** The first level pays past the budgets, then launches the next level of itself. */
@Workflow({
  name: "paid-level-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidLevelWorkflowStart)
      .toAction(LevelOrderAction)
      .toOneOf([
        toWorkflow(() => PaidLevelWorkflow).toFinish(PaidLevelWorkflowFinish),
        toFinish(PaidLevelWorkflowFinish),
      ]),
  ],
  executionLimits: { maxDepth: 2 },
})
export class PaidLevelWorkflow {}

@startOf("paid-launch")
export class PaidLaunchWorkflowStart {}
@finishOf("paid-launch")
export class PaidLaunchWorkflowFinish {}

/** Charged past the budgets, then two actions at once. */
@Workflow({
  name: "paid-launch-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidLaunchWorkflowStart)
      .toAction(OverspendOrderAction)
      .inParallel([toAction(NoteOrderAction), toAction(MemoOrderAction)])
      .join()
      .toFinish(PaidLaunchWorkflowFinish),
  ],
})
export class PaidLaunchWorkflow {}

@startOf("paid-race")
export class PaidRaceWorkflowStart {}
@finishOf("paid-race")
export class PaidRaceWorkflowFinish {}

/** Two branches: the first spends the last of the budget, the second comes after it. */
@Workflow({
  name: "paid-race-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidRaceWorkflowStart)
      .inParallel([toAction(ChargeOrderAction), toAction(NoteOrderAction)])
      .join()
      .toFinish(PaidRaceWorkflowFinish),
  ],
})
export class PaidRaceWorkflow {}

@startOf("paid-hold")
export class PaidHoldWorkflowStart {}
@finishOf("paid-hold")
export class PaidHoldWorkflowFinish {}

/** Held until the test lets it go, then noted: the budgets as they are when it goes on. */
@Workflow({
  name: "paid-hold-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PaidHoldWorkflowStart)
      .toAction(HoldOrderAction)
      .toAction(NoteOrderAction)
      .toFinish(PaidHoldWorkflowFinish),
  ],
})
export class PaidHoldWorkflow {}
