import { Action, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { TripBookedDto, TripFlightDto, TripHotelDto } from "../dto/trip.dto.js";

/** Gathers the two bookings' ids into the trip's answer. */
@Action({
  name: "trip-booked-action",
  description: "The flight and the hotel, booked",
  input: { flight: TripFlightDto, hotel: TripHotelDto },
  output: TripBookedDto,
})
export class TripBookedAction implements ActionHandler<TripBookedAction> {
  execute(input: InputOf<TripBookedAction>): Promise<OutputOf<TripBookedAction>> {
    return Promise.resolve({
      flightBookingId: input.flight.bookingId,
      hotelBookingId: input.hotel.bookingId,
    });
  }
}
