import { WorkflowFinish, type FinishHandler, type InputOf, type OutputOf } from "@agboss/core";
import { TripFlightDto, TripHotelDto, TripBookedDto } from "../dtos/trip.dto.js";

/** Where a booked trip finishes — and commits both bookings: nothing undoes them any more. */
@WorkflowFinish({
  name: "trip-booked-workflow-finish",
  description: "The flight and the hotel, booked",
  input: { flight: TripFlightDto, hotel: TripHotelDto },
  output: TripBookedDto,
})
export class TripBookedWorkflowFinish implements FinishHandler<TripBookedWorkflowFinish> {
  finish(input: InputOf<TripBookedWorkflowFinish>): OutputOf<TripBookedWorkflowFinish> {
    return {
      flightBookingId: input.flight.value.bookingId,
      hotelBookingId: input.hotel.value.bookingId,
    };
  }
}
