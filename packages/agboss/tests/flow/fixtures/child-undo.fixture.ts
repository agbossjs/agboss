import { Text } from "../../../src/dto/index.js";
import {
  Action,
  Arbiter,
  Arbitrate,
  ChildPlacement,
  EmptyEnvironment,
  QuorumNotReachedError,
  StepError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked, Ttl,
} from "../../../src/index.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { Injectable } from "../../../src/components/decorators.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";
import { onStart, toAction, toFinish, toWorkflow } from "../../helpers/flow.js";
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
 * #1281b — a child's undoable actions bubble up to its parent: a trip child reserves a seat and a
 * room (both undoable, committed by no action of its own) and finishes. Its parents keep them open
 * until their own finish commits them, or undo them: a quorum that went on without the child's
 * branch (an arbiter counts only the car), the parent's own failure after the child (a charge that
 * fails), two levels up through a middle workflow, and the same with the child on any instance.
 */

export class TripDto {
  @Text({ prompt: "the trip's seat and room" })
  tripId!: string;
}

export class CarDto {
  @Text({ prompt: "the car's id" })
  carId!: string;
}

/** What the tests make fail: the card charge after the child. */
@Injectable()
export class TripDesk {
  charge(): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "reserve-car-action",
  description: "Reserves a car; nothing undoes it",
  input: { request: TripRequestDto },
  output: CarDto,
})
export class ReserveCarAction {
  execute(): Promise<CarDto> {
    return Promise.resolve({ carId: "car-1" });
  }
}

@Action({
  name: "confirm-trip-action",
  description: "Names the trip by its seat and room; it commits nothing",
  input: { seat: TripSeatDto, room: TripRoomDto },
  output: TripDto,
})
export class ConfirmTripAction {
  execute(input: {
    readonly seat: Tracked<TripSeatDto>;
    readonly room: Tracked<TripRoomDto>;
  }): Promise<TripDto> {
    return Promise.resolve({ tripId: `${input.seat.seatId}+${input.room.roomId}` });
  }
}

@Action({
  name: "charge-trip-action",
  description: "Charges the card for the trip",
  input: { trip: TripDto },
  output: TripSummaryDto,
  deps: [TripDesk],
})
export class ChargeTripAction {
  constructor(private readonly tripDesk: TripDesk) {}

  async execute(): Promise<TripSummaryDto> {
    await this.tripDesk.charge();
    return { summary: "charged" };
  }
}

@Action({
  name: "review-trip-action",
  description: "Reads what the quorum counted",
  input: { trip: optional(TripDto), car: optional(CarDto) },
  output: TripSummaryDto,
})
export class ReviewTripAction {
  execute(): Promise<TripSummaryDto> {
    return Promise.resolve({ summary: "reviewed" });
  }
}

@WorkflowStart({ name: "trip-child-workflow-start", description: "A trip", input: TripRequestDto })
export class TripChildWorkflowStart {}

@WorkflowFinish({ name: "trip-child-workflow-finish", description: "Booked", output: TripDto })
export class TripChildWorkflowFinish {}

/** Two undoable reservations and a finish: nothing of its own commits them. */
@Workflow({
  name: "trip-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TripChildWorkflowStart)
      .toAction(BookSeatAction)
      .toAction(BookRoomAction)
      .toAction(ConfirmTripAction)
      .toFinish(TripChildWorkflowFinish),
  ],
  providers: [TripBookingDesk],
})
export class TripChildWorkflow {}

@WorkflowStart({ name: "remote-trip-workflow-start", description: "A trip", input: TripRequestDto })
export class RemoteTripWorkflowStart {}

@WorkflowFinish({ name: "remote-trip-workflow-finish", description: "Booked", output: TripDto })
export class RemoteTripWorkflowFinish {}

/** The same trip on any instance: its moved entries come back with its finish's state. */
@Workflow({
  placement: ChildPlacement.AnyWorker,
  name: "remote-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RemoteTripWorkflowStart)
      .toAction(BookSeatAction)
      .toAction(BookRoomAction)
      .toAction(ConfirmTripAction)
      .toFinish(RemoteTripWorkflowFinish),
  ],
  providers: [TripBookingDesk],
})
export class RemoteTripWorkflow {}

@WorkflowStart({ name: "middle-trip-workflow-start", description: "A trip", input: TripRequestDto })
export class MiddleTripWorkflowStart {}

@WorkflowFinish({ name: "middle-trip-workflow-finish", description: "Booked", output: TripDto })
export class MiddleTripWorkflowFinish {}

/** A child that only runs the trip child: what it holds is its own child's. */
@Workflow({
  name: "middle-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(MiddleTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .toFinish(MiddleTripWorkflowFinish),
  ],
})
export class MiddleTripWorkflow {}

/** Counts the car only. */
@Arbiter({ name: "car-only-arbiter" })
export class CarOnlyArbiter {
  @Arbitrate(TripChildWorkflow)
  isTrip(_answer: TripDto): boolean {
    return false;
  }

  @Arbitrate(ReserveCarAction)
  isCar(_answer: CarDto): boolean {
    return true;
  }
}

/** Counts the car only, over the middle workflow. */
@Arbiter({ name: "car-over-middle-arbiter" })
export class CarOverMiddleArbiter {
  @Arbitrate(MiddleTripWorkflow)
  isTrip(_answer: TripDto): boolean {
    return false;
  }

  @Arbitrate(ReserveCarAction)
  isCar(_answer: CarDto): boolean {
    return true;
  }
}

/** Counts the car only, over the remote trip. */
@Arbiter({ name: "car-over-remote-arbiter" })
export class CarOverRemoteArbiter {
  @Arbitrate(RemoteTripWorkflow)
  isTrip(_answer: TripDto): boolean {
    return false;
  }

  @Arbitrate(ReserveCarAction)
  isCar(_answer: CarDto): boolean {
    return true;
  }
}

/** Counts nothing: the quorum is not reached. */
@Arbiter({ name: "refuse-trip-arbiter" })
export class RefuseTripArbiter {
  @Arbitrate(TripChildWorkflow)
  isTrip(_answer: TripDto): boolean {
    return false;
  }

  @Arbitrate(ReserveCarAction)
  isCar(_answer: CarDto): boolean {
    return false;
  }
}

@WorkflowFinish({ name: "trip-booked-workflow-finish", description: "Booked", output: TripDto })
export class TripBookedWorkflowFinish {}

@WorkflowFinish({
  name: "trip-charged-workflow-finish",
  description: "Paid",
  output: TripSummaryDto,
})
export class TripChargedWorkflowFinish {}

const startOf = (name: string): ReturnType<typeof WorkflowStart> =>
  WorkflowStart({ name: `${name}-workflow-start`, description: "A trip", input: TripRequestDto });

@startOf("quorum-trip")
export class QuorumTripWorkflowStart {}

@Workflow({
  name: "quorum-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(QuorumTripWorkflowStart)
      .inParallel([toWorkflow(TripChildWorkflow), toAction(ReserveCarAction)])
      .arbitratedBy(CarOnlyArbiter)
      .joinQuorum({ min: 1, max: 2 })
      .onError(QuorumNotReachedError, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewTripAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class QuorumTripWorkflow {}

@startOf("refused-trip")
export class RefusedTripWorkflowStart {}

@Workflow({
  name: "refused-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefusedTripWorkflowStart)
      .inParallel([toWorkflow(TripChildWorkflow), toAction(ReserveCarAction)])
      .arbitratedBy(RefuseTripArbiter)
      .joinQuorum({ min: 1, max: 2 })
      .onError(QuorumNotReachedError, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewTripAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class RefusedTripWorkflow {}

@startOf("commit-trip")
export class CommitTripWorkflowStart {}

@Workflow({
  name: "commit-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(CommitTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .toFinish(TripBookedWorkflowFinish),
  ],
})
export class CommitTripWorkflow {}

@startOf("charged-trip")
export class ChargedTripWorkflowStart {}

@Workflow({
  name: "charged-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChargedTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .toAction(ChargeTripAction)
      .toFinish(TripChargedWorkflowFinish),
  ],
  providers: [TripDesk],
})
export class ChargedTripWorkflow {}

@startOf("declined-trip")
export class DeclinedTripWorkflowStart {}

/** #1281 (10): the charge fails and an `.onError` takes it: the child's reservations are undone first. */
@Workflow({
  name: "declined-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeclinedTripWorkflowStart)
      .toWorkflow(TripChildWorkflow)
      .toAction(ChargeTripAction)
      .onError(StepError.Action, toFinish(TripNotReservedWorkflowFinish))
      .toFinish(TripChargedWorkflowFinish),
  ],
  providers: [TripDesk],
})
export class DeclinedTripWorkflow {}

@startOf("nested-quorum-trip")
export class NestedQuorumTripWorkflowStart {}

@Workflow({
  name: "nested-quorum-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(NestedQuorumTripWorkflowStart)
      .inParallel([toWorkflow(MiddleTripWorkflow), toAction(ReserveCarAction)])
      .arbitratedBy(CarOverMiddleArbiter)
      .joinQuorum({ min: 1, max: 2 })
      .onError(QuorumNotReachedError, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewTripAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class NestedQuorumTripWorkflow {}

@startOf("nested-charged-trip")
export class NestedChargedTripWorkflowStart {}

@Workflow({
  name: "nested-charged-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(NestedChargedTripWorkflowStart)
      .toWorkflow(MiddleTripWorkflow)
      .toAction(ChargeTripAction)
      .toFinish(TripChargedWorkflowFinish),
  ],
  providers: [TripDesk],
})
export class NestedChargedTripWorkflow {}

@startOf("remote-quorum-trip")
export class RemoteQuorumTripWorkflowStart {}

@Workflow({
  name: "remote-quorum-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RemoteQuorumTripWorkflowStart)
      .inParallel([toWorkflow(RemoteTripWorkflow), toAction(ReserveCarAction)])
      .arbitratedBy(CarOverRemoteArbiter)
      .joinQuorum({ min: 1, max: 2 })
      .onError(QuorumNotReachedError, toFinish(TripNotReservedWorkflowFinish))
      .toAction(ReviewTripAction)
      .toFinish(TripReviewedWorkflowFinish),
  ],
})
export class RemoteQuorumTripWorkflow {}

@startOf("remote-charged-trip")
export class RemoteChargedTripWorkflowStart {}

@Workflow({
  name: "remote-charged-trip-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RemoteChargedTripWorkflowStart)
      .toWorkflow(RemoteTripWorkflow)
      .toAction(ChargeTripAction)
      .toFinish(TripChargedWorkflowFinish),
  ],
  providers: [TripDesk],
})
export class RemoteChargedTripWorkflow {}

/** Every parent above, on one application. */
@Application({
  name: "child-undo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    QuorumTripWorkflow,
    RefusedTripWorkflow,
    CommitTripWorkflow,
    ChargedTripWorkflow,
    DeclinedTripWorkflow,
    NestedQuorumTripWorkflow,
    NestedChargedTripWorkflow,
    RemoteQuorumTripWorkflow,
    RemoteChargedTripWorkflow,
  ],
  budgets: TEST_BUDGETS,
})
export class ChildUndoApplication {}
