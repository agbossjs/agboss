import { expect } from "vitest";
import { CompensationReason } from "@agboss/core";
import { testWith } from "@agboss/core/testing";
import { BookFlightAction } from "../../../../src/travel/actions/book-flight.action.js";
import { BookHotelAction } from "../../../../src/travel/actions/book-hotel.action.js";
import { CancelFlightAction } from "../../../../src/travel/actions/cancel-flight.action.js";
import {
  BookingDeskService,
  BookingFailedError,
} from "../../../../src/travel/services/booking-desk.service.js";
import { TripBookedWorkflowFinish } from "../../../../src/travel/workflows/trip/trip-booked.workflow-finish.js";
import { TripNotBookedWorkflowFinish } from "../../../../src/travel/workflows/trip/trip-not-booked.workflow-finish.js";
import { TripWorkflowStart } from "../../../../src/travel/workflows/trip/trip.workflow-start.js";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";

/**
 * A failed join undoes its finished branches automatically (#340): the flight booked, the hotel
 * refused — the flight is cancelled (`CompensationReason.JoinFailed`) before the `.onJoinError`
 * side path finishes; both booked — the finish commits them, nothing is undone.
 */

const test = testWith(FlowPatternsApplication);

const REQUEST = { destination: "Lisbon", nights: 3 };

test("both booked: the finish commits them, nothing is undone", async ({ app, mockOf }) => {
  const desk = mockOf(BookingDeskService);
  desk.bookFlight.mockResolvedValue("flight-1");
  desk.bookHotel.mockResolvedValue("hotel-1");

  const result = await app.execute(TripWorkflowStart, REQUEST);

  expect(result).toFinishWith(TripBookedWorkflowFinish, {
    flightBookingId: "flight-1",
    hotelBookingId: "hotel-1",
  });
  expect(result.compensations).toEqual([]);
  expect(desk.cancelFlight.mock.calls).toHaveLength(0);
});

test("the hotel refused: the booked flight is cancelled before the side path", async ({
  app,
  mockOf,
}) => {
  const desk = mockOf(BookingDeskService);
  desk.bookFlight.mockResolvedValue("flight-1");
  desk.bookHotel.mockRejectedValue(new BookingFailedError("no rooms"));

  const result = await app.execute(TripWorkflowStart, REQUEST);

  expect(result).toFinishWith(TripNotBookedWorkflowFinish, REQUEST);
  expect(result).toHaveCompensated(BookFlightAction, {
    by: CancelFlightAction,
    reason: CompensationReason.JoinFailed,
  });
  expect(result).toHaveHandledError(BookingFailedError, { at: BookHotelAction });
  expect(desk.cancelFlight.mock.calls).toEqual([
    ["flight-1", `${result.executionId}:book-flight-action:1:compensation`],
  ]);
  expect(desk.cancelHotel.mock.calls).toHaveLength(0);
});
