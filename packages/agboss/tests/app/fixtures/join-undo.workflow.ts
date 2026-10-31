import { Workflow, WorkflowFinish, WorkflowStart } from "../../../src/index.js";
import { start } from "../../helpers/flow.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { BookingDto, BookItemAction, ConfirmBookingAction } from "./finished-undo.workflow.js";
import { GatedItemAction } from "./remote-child-yield.workflow.js";

/**
 * #605 — the roots that undo on their own: a failed join's undo (the item booked, undone by a
 * cancel, beside its gated check; an item to fail fails its check past the gate, so the join fails
 * and undoes the booking before the execution fails), and a root's own undo (booked, then checked).
 */

@WorkflowStart({
  name: "join-undo-workflow-start",
  description: "One item, booked and checked side by side",
  input: ItemDto,
})
export class JoinUndoWorkflowStart {}

@WorkflowFinish({
  name: "join-undo-workflow-finish",
  description: "The item, booked and checked",
  output: ItemResultDto,
})
export class JoinUndoWorkflowFinish {}

@Workflow({
  name: "join-undo-workflow",
  version: "1.0.0",
  flow: [
    start(JoinUndoWorkflowStart)
      .returns(ItemDto)
      .toParallelActions(BookItemAction, GatedItemAction)
      .join()
      .returns(BookingDto)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(JoinUndoWorkflowFinish),
  ],
})
export class JoinUndoWorkflow {}

@WorkflowStart({
  name: "root-undo-workflow-start",
  description: "One item, booked then checked by the root itself",
  input: ItemDto,
})
export class RootUndoWorkflowStart {}

@WorkflowFinish({
  name: "root-undo-workflow-finish",
  description: "The item, booked and checked",
  output: ItemResultDto,
})
export class RootUndoWorkflowFinish {}

/** #605 — a root's own undo: the booking undone when its check fails, before the root fails. */
@Workflow({
  name: "root-undo-workflow",
  version: "1.0.0",
  flow: [
    start(RootUndoWorkflowStart)
      .returns(ItemDto)
      .toAction(BookItemAction)
      .returns(BookingDto)
      .toAction(GatedItemAction)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(RootUndoWorkflowFinish),
  ],
})
export class RootUndoWorkflow {}
