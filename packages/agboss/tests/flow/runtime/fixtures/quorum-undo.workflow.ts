import {
  Arbiter,
  Arbitrate,
  EmptyEnvironment,
  QuorumNotReachedError,
  Action,
  Workflow,
  WorkflowStart,
} from "../../../../src/index.js";
import { optional } from "../../../../src/flow/dto-wrappers.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { onStart, toAction, toFinish } from "../../../helpers/flow.js";
import {
  NotReservedWorkflowFinish,
  ReservedDto,
  ReservedWorkflowFinish,
  ReserveRoomAction,
  ReserveSeatAction,
  RoomDto,
  SeatDto,
  UndoDesk,
  UndoRequestDto,
} from "./undo.workflow.js";

/**
 * #1281b — quorum joins over undoable actions: an arbiter counts only the room, so the seat that
 * completed anyway is undone at the join before the winning path goes on; when no answer is counted
 * the quorum is not reached, and both completed reservations are undone before `.onError`.
 */

/** Counts the room, refuses the seat. */
@Arbiter({ name: "room-only-arbiter" })
export class RoomOnlyArbiter {
  @Arbitrate(ReserveSeatAction)
  isSeat(_answer: SeatDto): boolean {
    return false;
  }

  @Arbitrate(ReserveRoomAction)
  isRoom(_answer: RoomDto): boolean {
    return true;
  }
}

/** Refuses everything. */
@Arbiter({ name: "refuse-all-arbiter" })
export class RefuseAllArbiter {
  @Arbitrate(ReserveSeatAction)
  isSeat(_answer: SeatDto): boolean {
    return false;
  }

  @Arbitrate(ReserveRoomAction)
  isRoom(_answer: RoomDto): boolean {
    return false;
  }
}

/** Reads what the quorum counted: each reservation may be left out. */
@Action({
  name: "review-reservations-action",
  description: "Reads the counted reservations",
  input: { seat: optional(SeatDto), room: optional(RoomDto) },
  output: ReservedDto,
})
export class ReviewReservationsAction {
  execute(): Promise<ReservedDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

@WorkflowStart({
  name: "quorum-excluded-workflow-start",
  description: "A reservation",
  input: UndoRequestDto,
})
export class QuorumExcludedWorkflowStart {}

@WorkflowStart({
  name: "quorum-refused-workflow-start",
  description: "A reservation nobody accepts",
  input: UndoRequestDto,
})
export class QuorumRefusedWorkflowStart {}

@Workflow({
  name: "quorum-excluded-workflow",
  version: "1.0.0",
  flow: [
    onStart(QuorumExcludedWorkflowStart)
      .inParallel([toAction(ReserveSeatAction), toAction(ReserveRoomAction)])
      .arbitratedBy(RoomOnlyArbiter)
      .joinQuorum({ min: 1 })
      .onError(QuorumNotReachedError, toFinish(NotReservedWorkflowFinish))
      .toAction(ReviewReservationsAction)
      .toFinish(ReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class QuorumExcludedWorkflow {}

@Workflow({
  name: "quorum-refused-workflow",
  version: "1.0.0",
  flow: [
    onStart(QuorumRefusedWorkflowStart)
      .inParallel([toAction(ReserveSeatAction), toAction(ReserveRoomAction)])
      .arbitratedBy(RefuseAllArbiter)
      .joinQuorum({ min: 1 })
      .onError(QuorumNotReachedError, toFinish(NotReservedWorkflowFinish))
      .toAction(ReviewReservationsAction)
      .toFinish(ReservedWorkflowFinish),
  ],
  providers: [UndoDesk],
})
export class QuorumRefusedWorkflow {}

@Application({
  name: "quorum-undo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuorumExcludedWorkflow, QuorumRefusedWorkflow],
  budgets: TEST_BUDGETS,
})
export class QuorumUndoApplication {}
