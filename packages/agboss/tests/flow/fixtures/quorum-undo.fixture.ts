import { StepError } from "../../../src/core/error-families/step-errors.js";
import {
  Arbiter,
  Arbitrate,
  EmptyEnvironment,
  Action,
  Workflow,
  WorkflowStart,
  Ttl,
} from "../../../src/index.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";
import { onStart, toAction, toFinish } from "../../helpers/flow.js";
import {
  BookRoomAction,
  BookSeatAction,
  TripBookingDesk,
  TripNotReservedWorkflowFinish,
  TripRequestDto,
  TripReviewedWorkflowFinish,
  TripRoomDto,
  TripSeatDto,
  TripSummaryDto,
} from "./trip-undo-parts.js";

export * from "./trip-undo-parts.js";

/**
 * #1281b — quorum joins over undoable actions: an arbiter counts only the room, so the seat that
 * completed anyway is undone at the join before the winning path goes on; when no answer is counted
 * the quorum is not reached, and both completed reservations are undone before `.onError`.
 */

/** Counts the room, refuses the seat. */
@Arbiter({ name: "room-only-arbiter" })
export class RoomOnlyArbiter {
  @Arbitrate(BookSeatAction)
  isSeat(_answer: TripSeatDto): boolean {
    return false;
  }

  @Arbitrate(BookRoomAction)
  isRoom(_answer: TripRoomDto): boolean {
    return true;
  }
}

/** Refuses everything. */
@Arbiter({ name: "refuse-all-arbiter" })
export class RefuseAllArbiter {
  @Arbitrate(BookSeatAction)
  isSeat(_answer: TripSeatDto): boolean {
    return false;
  }

  @Arbitrate(BookRoomAction)
  isRoom(_answer: TripRoomDto): boolean {
    return false;
  }
}

/** Reads what the quorum counted: each reservation may be left out. */
@Action({
  name: "review-reservations-action",
  description: "Reads the counted reservations",
  input: { seat: optional(TripSeatDto), room: optional(TripRoomDto) },
  output: TripSummaryDto,
})
export class ReviewReservationsAction {
  execute(): Promise<TripSummaryDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

@WorkflowStart({
  name: "quorum-excluded-workflow-start",
  description: "A reservation",
  input: TripRequestDto,
})
export class QuorumExcludedWorkflowStart {}

@WorkflowStart({
  name: "quorum-refused-workflow-start",
  description: "A reservation nobody accepts",
  input: TripRequestDto,
})
export class QuorumRefusedWorkflowStart {}

@Workflow({
  name: "quorum-excluded-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(QuorumExcludedWorkflowStart)
      .inParallel([toAction(BookSeatAction), toAction(BookRoomAction)])
      .arbitratedBy(RoomOnlyArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewReservationsAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
  providers: [TripBookingDesk],
})
export class QuorumExcludedWorkflow {}

@Workflow({
  name: "quorum-refused-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(QuorumRefusedWorkflowStart)
      .inParallel([toAction(BookSeatAction), toAction(BookRoomAction)])
      .arbitratedBy(RefuseAllArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewReservationsAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
  providers: [TripBookingDesk],
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
