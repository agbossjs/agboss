import { Action, type ActionHandler, type InputOf, type OutputOf } from "@agboss/core";
import { FlightBookingDto } from "../dto/flight-booking.dto.js";
import { OffsiteBookingDto } from "../dto/offsite-booking.dto.js";
import { VenueBookingDto } from "../dto/venue-booking.dto.js";

/** Puts both buyers' answers into one line each. */
@Action({
  name: "offsite-booking-action",
  description: "What was booked",
  input: {
    venue: VenueBookingDto,
    flights: FlightBookingDto,
  },
  output: OffsiteBookingDto,
})
export class OffsiteBookingAction implements ActionHandler<OffsiteBookingAction> {
  execute(input: InputOf<OffsiteBookingAction>): Promise<OutputOf<OffsiteBookingAction>> {
    const venue = input.venue;
    const flights = input.flights;
    const venueLine = `venue ${venue.venue}: ${venue.isBooked ? "booked" : "declined"}`;
    const flightsLine = `flights ${flights.route}: ${flights.isBooked ? "booked" : "declined"}`;
    return Promise.resolve({ summary: `${venueLine}; ${flightsLine}` });
  }
}
