import { Workflow, onStart, toFinish } from "@agboss/core";
import { BookFlightAction } from "../../actions/book-flight.action.js";
import { BookHotelAction } from "../../actions/book-hotel.action.js";
import { TripBookedAction } from "../../actions/trip-booked.action.js";
import { BookingDeskService, BookingFailedError } from "../../services/booking-desk.service.js";
import { TripBookedWorkflowFinish } from "./trip-booked.workflow-finish.js";
import { TripNotBookedWorkflowFinish } from "./trip-not-booked.workflow-finish.js";
import { TripWorkflowStart } from "./trip.workflow-start.js";

/**
 * A failed join undoes its finished branches automatically (#340): the flight and the hotel are
 * booked at once, each with `compensateWith` and no `committedBy` — the finish commits them. When
 * one booking fails, the other, finished one is cancelled before the `.onError` side path runs
 * (`CompensationReason.JoinFailed`): no path could say it, the join's values never reach it.
 */
@Workflow({
  name: "trip-workflow",
  version: "1.0.0",
  flow: [
    onStart(TripWorkflowStart)
      .toParallelActions(BookFlightAction, BookHotelAction)
      .join()
      .onError(
        BookingFailedError, // the hotel failed: the finished flight is cancelled before this path runs
        toFinish(TripNotBookedWorkflowFinish),
      )
      .toAction(TripBookedAction)
      .toFinish(TripBookedWorkflowFinish),
  ],
  providers: [BookingDeskService],
})
export class TripWorkflow {}
