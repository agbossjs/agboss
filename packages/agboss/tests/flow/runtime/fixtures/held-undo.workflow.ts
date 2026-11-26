import { LimitError } from "../../../../src/core/error-families/limit-errors.js";
import {
  Action,
  Arbiter,
  ArbiterModel,
  Arbitrate,
  type CompensationReason,
  type CompensationStartEvent,
  Decision,
  Observer,
  StepError,
  Workflow,
  WorkflowStart,
  listOf,
  Ttl,
  type Tracked,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { Text } from "../../../../src/dto/index.js";
import { optional } from "../../../../src/flow/dto-wrappers.js";
import { TestDecisionsModelProvider } from "../../../../src/testing/test-model-provider.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { onStart, toAction, toFinish, toWorkflow } from "../../../helpers/flow.js";
import {
  BookRoomAction,
  BookSeatAction,
  CarDto,
  ChargeTripAction,
  ReserveCarAction,
  ReviewTripAction,
  TripBookingDesk,
  TripChildWorkflow,
  TripDesk,
  TripDto,
  TripNotReservedWorkflowFinish,
  TripRequestDto,
  TripReviewedWorkflowFinish,
  TripRoomDto,
  TripSeatDto,
  TripSummaryDto,
} from "../../fixtures/child-undo.fixture.js";

/**
 * #1281 — what a launch's failure leaves undone, nowhere:
 * - a branch whose undoable action (or child workflow) answered, then its arbiter threw or its
 *   arbiter's model call met a spent budget: the branch fails with its entries, its join undoes them;
 * - a join that fails into its `.onError` (a failed branch, a quorum not reached, a list past
 *   `maxItems`) after an earlier child finished: what that child left open is undone before the side
 *   path (`CompensationReason.StepFailed`), as for a plain step's failure (#1281 (10)).
 */

/** Throws on the seat's answer, counts the room. */
@Arbiter({ name: "throwing-seat-arbiter" })
export class ThrowingSeatArbiter {
  @Arbitrate(BookSeatAction)
  isSeat(_answer: TripSeatDto): boolean {
    throw new Error("the arbiter crashed");
  }

  @Arbitrate(BookRoomAction)
  isRoom(_answer: TripRoomDto): boolean {
    return true;
  }
}

/** Throws on the child trip's answer, counts the car. */
@Arbiter({ name: "throwing-trip-arbiter" })
export class ThrowingTripArbiter {
  @Arbitrate(TripChildWorkflow)
  isTrip(_answer: TripDto): boolean {
    throw new Error("the arbiter crashed");
  }

  @Arbitrate(ReserveCarAction)
  isCar(_answer: CarDto): boolean {
    return true;
  }
}

/**
 * Asks its own model about the seat twice: each call behind the budget check, so the second one meets
 * the budget the first one spent.
 */
@Arbiter({
  name: "asking-seat-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  deps: [ArbiterModel],
})
export class AskingSeatArbiter {
  constructor(private readonly arbiterModel: ArbiterModel) {}

  @Arbitrate(BookSeatAction)
  async isSeat(answer: TripSeatDto): Promise<boolean> {
    const questions = { fine: Decision.boolean("Is the seat fine?") };
    await this.arbiterModel.decide({ state: `seat ${answer.seatId}`, questions });
    const read = await this.arbiterModel.decide({
      state: `seat ${answer.seatId} again`,
      questions,
    });
    return read.fine.probability > 0.5;
  }

  @Arbitrate(BookRoomAction)
  isRoom(_answer: TripRoomDto): boolean {
    return true;
  }
}

/** Counts nothing. */
@Arbiter({ name: "refuse-cars-arbiter" })
export class RefuseCarsArbiter {
  @Arbitrate(ReserveCarAction)
  isCar(_answer: CarDto): boolean {
    return false;
  }
}

/** Two cars for the trip: one more than the launch takes. */
@Action({
  name: "list-cars-action",
  description: "The cars of the trip",
  input: { trip: TripDto },
  output: listOf(CarDto),
})
export class ListCarsAction {
  execute(): Promise<CarDto[]> {
    return Promise.resolve([{ carId: "car-1" }, { carId: "car-2" }]);
  }
}

export class CheckedCarDto {
  @Text({ prompt: "the checked car's id" })
  checkedId!: string;
}

@Action({
  name: "check-car-action",
  description: "Checks one car",
  input: { car: CarDto },
  output: CheckedCarDto,
})
export class CheckCarAction {
  execute(input: { readonly car: Tracked<CarDto> }): Promise<CheckedCarDto> {
    return Promise.resolve({ checkedId: input.car.carId });
  }
}

/** What a quorum of the seat and the room counted. */
@Action({
  name: "review-booking-action",
  description: "Reads what the quorum counted",
  input: { seat: optional(TripSeatDto), room: optional(TripRoomDto) },
  output: TripSummaryDto,
})
export class ReviewBookingAction {
  execute(): Promise<TripSummaryDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

/** What the charge and the car gave. */
@Action({
  name: "review-charge-action",
  description: "Reads the charge and the car",
  input: { summary: TripSummaryDto, car: CarDto },
  output: TripSummaryDto,
})
export class ReviewChargeAction {
  execute(): Promise<TripSummaryDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

/** The cars a launch gave. */
@Action({
  name: "review-cars-action",
  description: "Reads the trip and its cars",
  input: { trip: TripDto, cars: listOf(CarDto) },
  output: TripSummaryDto,
})
export class ReviewCarsAction {
  execute(): Promise<TripSummaryDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

/** The cars a per-item launch checked. */
@Action({
  name: "review-checked-cars-action",
  description: "Reads the checked cars",
  input: { checked: listOf(CheckedCarDto) },
  output: TripSummaryDto,
})
export class ReviewCheckedCarsAction {
  execute(): Promise<TripSummaryDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

const startOf = (name: string): ReturnType<typeof WorkflowStart> =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "A trip", input: TripRequestDto });

@startOf("arbiter-throws")
export class ArbiterThrowsWorkflowStart {}

@Workflow({
  name: "arbiter-throws-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ArbiterThrowsWorkflowStart)
      .inParallel([toAction(BookSeatAction), toAction(BookRoomAction)])
      .arbitratedBy(ThrowingSeatArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewBookingAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class ArbiterThrowsWorkflow {}

@startOf("arbiter-throws-child")
export class ArbiterThrowsChildWorkflowStart {}

@Workflow({
  name: "arbiter-throws-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ArbiterThrowsChildWorkflowStart)
      .inParallel([toWorkflow(TripChildWorkflow), toAction(ReserveCarAction)])
      .arbitratedBy(ThrowingTripArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewTripAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class ArbiterThrowsChildWorkflow {}

@startOf("arbiter-out-of-budget")
export class ArbiterOutOfBudgetWorkflowStart {}

@Workflow({
  name: "arbiter-out-of-budget-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ArbiterOutOfBudgetWorkflowStart)
      .inParallel([toAction(BookSeatAction), toAction(BookRoomAction)])
      .arbitratedBy(AskingSeatArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewBookingAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class ArbiterOutOfBudgetWorkflow {}

@startOf("join-declined-trip")
export class JoinDeclinedTripWorkflowStart {}

/** #1281 (10) in a launch: the charge fails inside `.inParallel`, the join's `.onError` takes it. */
@Workflow({
  name: "join-declined-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(JoinDeclinedTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .inParallel([toAction(ChargeTripAction), toAction(ReserveCarAction)])
      .join()
      .onError(StepError.Action, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewChargeAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
  providers: [TripDesk],
})
export class JoinDeclinedTripWorkflow {}

@startOf("quorum-missed-trip")
export class QuorumMissedTripWorkflowStart {}

@Workflow({
  name: "quorum-missed-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(QuorumMissedTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .inParallel([toAction(ReserveCarAction), toAction(ReserveCarAction)])
      .arbitratedBy(RefuseCarsArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewCarsAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class QuorumMissedTripWorkflow {}

@startOf("too-many-cars-trip")
export class TooManyCarsTripWorkflowStart {}

@Workflow({
  name: "too-many-cars-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TooManyCarsTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .toAction(ListCarsAction)
      .forEachItem(toAction(CheckCarAction), { maxItems: 1 })
      .join()
      .onError(LimitError.Items, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewCheckedCarsAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class TooManyCarsTripWorkflow {}

/** The reason of every undo that started, in order: which unwind ran it. */
export const undoReasons: CompensationReason[] = [];

@Observer({ name: "held-undo-reasons" })
export class HeldUndoReasons {
  onCompensationStart(event: CompensationStartEvent): void {
    undoReasons.push(event.reason);
  }
}

/** Every workflow above. */
@Application({
  name: "held-undo-application",
  version: "1.0.0",
  workflows: [
    ArbiterThrowsWorkflow,
    ArbiterThrowsChildWorkflow,
    ArbiterOutOfBudgetWorkflow,
    JoinDeclinedTripWorkflow,
    QuorumMissedTripWorkflow,
    TooManyCarsTripWorkflow,
  ],
  observers: [HeldUndoReasons],
  budgets: TEST_BUDGETS,
})
export class HeldUndoApplication {}
