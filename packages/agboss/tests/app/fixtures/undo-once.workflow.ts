import {
  BudgetExceededError,
  ChildPlacement,
  DecidedBy,
  EmptyEnvironment,
  Router,
  StepFailedError,
  ThisWorkflow,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  oneOf,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { caseOf, route, start, toFinish } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { hours } from "../../../src/units/index.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { BookingDto, ConfirmBookingAction } from "./finished-undo.workflow.js";
import { GatedItemAction } from "./remote-child-yield.workflow.js";
import {
  HookedExecutionTreeRepository,
  LevelItemAction,
  OverspendAction,
  PaidBookingAction,
  RefundBookingAction,
  SharedCheckpointSaver,
  UndoOnceLog,
} from "./undo-once.actions.js";

/**
 * #607 — one tree per automatic undo: a failed join's, a root's own (failed, cancelled at its gate,
 * out of budget, its refund's branch held back by the budget — #683), a held-back refund's (#675),
 * a `ParentInstance` child's, an `AnyInstance` child's, and a recursion level's followed by its
 * root's. Each books a paid item and fails after it.
 */

const startOf = (name: string) =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "One item", input: ItemDto });
const finishOf = (name: string) =>
  WorkflowFinish({ name: `${name}-workflow-finish`, description: "Done", output: ItemResultDto });

@startOf("once-root")
export class OnceRootWorkflowStart {}
@finishOf("once-root")
export class OnceRootWorkflowFinish {}

/** Booked, then checked (a gate item waits; an item to fail fails), then confirmed. */
@Workflow({
  name: "once-root-workflow",
  version: "1.0.0",
  flow: [
    start(OnceRootWorkflowStart)
      .returns(ItemDto)
      .toAction(PaidBookingAction)
      .returns(BookingDto)
      .toAction(GatedItemAction)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(OnceRootWorkflowFinish),
  ],
})
export class OnceRootWorkflow {}

@startOf("once-remote-child")
export class OnceRemoteChildWorkflowStart {}
@finishOf("once-remote-child")
export class OnceRemoteChildWorkflowFinish {}

@Workflow({
  name: "once-remote-child-workflow",
  version: "1.0.0",
  flow: [
    start(OnceRemoteChildWorkflowStart)
      .returns(ItemDto)
      .toAction(PaidBookingAction)
      .returns(BookingDto)
      .toAction(GatedItemAction)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(OnceRemoteChildWorkflowFinish),
  ],
})
export class OnceRemoteChildWorkflow {}

@startOf("once-join")
export class OnceJoinWorkflowStart {}
@finishOf("once-join")
export class OnceJoinWorkflowFinish {}

@Workflow({
  name: "once-join-workflow",
  version: "1.0.0",
  flow: [
    start(OnceJoinWorkflowStart)
      .returns(ItemDto)
      .toParallelActions(PaidBookingAction, GatedItemAction)
      .join()
      .returns(BookingDto)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(OnceJoinWorkflowFinish),
  ],
})
export class OnceJoinWorkflow {}

@startOf("once-join-side")
export class OnceJoinSideWorkflowStart {}
@finishOf("once-join-side")
export class OnceJoinSideWorkflowFinish {}

@WorkflowFinish({
  name: "once-join-side-failed-workflow-finish",
  description: "The item, its booking undone by the failed join",
  output: ItemDto,
})
export class OnceJoinSideFailedWorkflowFinish {}

/** A failed join's undo, then its side path to a finish: the finish never commits what was undone. */
@Workflow({
  name: "once-join-side-workflow",
  version: "1.0.0",
  flow: [
    start(OnceJoinSideWorkflowStart)
      .returns(ItemDto)
      .toParallelActions(PaidBookingAction, GatedItemAction)
      .join()
      .onJoinError(StepFailedError, toFinish(OnceJoinSideFailedWorkflowFinish))
      .returns(BookingDto)
      .returns(ItemResultDto)
      .toAction(ConfirmBookingAction)
      .toFinish(OnceJoinSideWorkflowFinish),
  ],
})
export class OnceJoinSideWorkflow {}

@startOf("once-local")
export class OnceLocalWorkflowStart {}
@finishOf("once-local")
export class OnceLocalWorkflowFinish {}

@Workflow({
  name: "once-local-workflow",
  version: "1.0.0",
  flow: [
    start(OnceLocalWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(OnceRootWorkflow)
      .returns(ItemResultDto)
      .toFinish(OnceLocalWorkflowFinish),
  ],
})
export class OnceLocalWorkflow {}

@startOf("once-any")
export class OnceAnyWorkflowStart {}
@finishOf("once-any")
export class OnceAnyWorkflowFinish {}

@Workflow({
  name: "once-any-workflow",
  version: "1.0.0",
  flow: [
    start(OnceAnyWorkflowStart)
      .returns(ItemDto)
      .toWorkflow(OnceRemoteChildWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ItemResultDto)
      .toFinish(OnceAnyWorkflowFinish),
  ],
})
export class OnceAnyWorkflow {}

@startOf("once-budget")
export class OnceBudgetWorkflowStart {}
@finishOf("once-budget")
export class OnceBudgetWorkflowFinish {}

/** Decides by code: a working step, so the budgets are checked before it. */
@Router({
  name: "once-budget-router",
  description: "Sends the checked item on",
  decidedBy: DecidedBy.Code,
  input: { result: ItemResultDto },
  routes: [{ target: ConfirmBookingAction }],
})
export class OnceBudgetRouter {
  route(): unknown {
    return ConfirmBookingAction;
  }
}

/** Booked, then a paid call past every budget: the next working step is refused, the root undone. */
@Workflow({
  name: "once-budget-workflow",
  version: "1.0.0",
  flow: [
    start(OnceBudgetWorkflowStart)
      .returns(ItemDto)
      .toAction(PaidBookingAction)
      .returns(BookingDto)
      .toAction(OverspendAction)
      .returns(ItemResultDto)
      .toRouter(OnceBudgetRouter)
      .chooseOne(
        route(ConfirmBookingAction)
          .toFinish(OnceBudgetWorkflowFinish),
      ),
  ],
})
export class OnceBudgetWorkflow {}

@startOf("once-held")
export class OnceHeldWorkflowStart {}
@finishOf("once-held")
export class OnceHeldWorkflowFinish {}

/**
 * #675: booked, a paid call past every budget, then the refund on the main path — held back as a
 * step, its `.onError` taking the budget's error to a finish: the booking is undone as an undo.
 */
@Workflow({
  name: "once-held-workflow",
  version: "1.0.0",
  flow: [
    start(OnceHeldWorkflowStart)
      .returns(ItemDto)
      .toAction(PaidBookingAction)
      .returns(BookingDto)
      .toAction(OverspendAction)
      .returns(ItemResultDto)
      .toAction(RefundBookingAction)
      .onError(BudgetExceededError, toFinish(OnceHeldWorkflowFinish))
      .toFinish(OnceHeldWorkflowFinish),
  ],
})
export class OnceHeldWorkflow {}

@startOf("once-branch")
export class OnceBranchWorkflowStart {}
@finishOf("once-branch")
export class OnceBranchWorkflowFinish {}

/**
 * #683: booked, a paid call past every budget, then the refund launched as a branch beside the
 * confirmation — held back as a step, the join fails: the root's automatic undo refunds once.
 */
@Workflow({
  name: "once-branch-workflow",
  version: "1.0.0",
  flow: [
    start(OnceBranchWorkflowStart)
      .returns(ItemDto)
      .toAction(PaidBookingAction)
      .returns(BookingDto)
      .toAction(OverspendAction)
      .returns(ItemResultDto)
      .toParallelActions(RefundBookingAction, ConfirmBookingAction)
      .join()
      .toFinish(OnceBranchWorkflowFinish),
  ],
})
export class OnceBranchWorkflow {}

@startOf("once-level")
export class OnceLevelWorkflowStart {}
@finishOf("once-level")
export class OnceLevelWorkflowFinish {}

/** Each level books; the root goes one level deeper, whose own failure undoes it, then the root. */
@Workflow({
  name: "once-level-workflow",
  version: "1.0.0",
  flow: [
    start(OnceLevelWorkflowStart)
      .returns(ItemDto)
      .toAction(PaidBookingAction)
      .returns(BookingDto)
      .toAction(LevelItemAction)
      .returns(oneOf(ItemDto, ItemResultDto))
      .switch(
        caseOf(ItemDto)
          .toWorkflow(ThisWorkflow)
          .returns(ItemResultDto)
          .toFinish(OnceLevelWorkflowFinish),
        caseOf(ItemResultDto)
          .toFinish(OnceLevelWorkflowFinish),
      ),
  ],
  maxDepth: 2,
})
export class OnceLevelWorkflow {}

@Application({
  name: "undo-once-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    OnceRootWorkflow,
    OnceJoinWorkflow,
    OnceJoinSideWorkflow,
    OnceLocalWorkflow,
    OnceAnyWorkflow,
    OnceBudgetWorkflow,
    OnceHeldWorkflow,
    OnceBranchWorkflow,
    OnceLevelWorkflow,
  ],
  observers: [UndoOnceLog],
  providers: [RecordingLogger, SharedCheckpointSaver, HookedExecutionTreeRepository],
  budgets: TEST_BUDGETS,
  // each root's record kept: what its undos were, as the tree ended
  executionRecordRetention: hours(1),
})
export class UndoOnceApplication {}
