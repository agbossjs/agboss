import { WorkflowFinish, type FinishHandler, type InputOf, type OutputOf } from "agboss";
import { FlightBookingDto } from "../dtos/flight-booking.dto.js";
import { OffsiteBookingDto } from "../dtos/offsite-booking.dto.js";
import { VenueBookingDto } from "../dtos/venue-booking.dto.js";

/** Where an offsite's booking finishes: both buyers' answers, as one line each. */
@WorkflowFinish({
  name: "offsite-booking-workflow-finish",
  description: "What was booked",
  input: {
    venue: VenueBookingDto,
    flights: FlightBookingDto,
  },
  output: OffsiteBookingDto,
})
export class OffsiteBookingWorkflowFinish implements FinishHandler<OffsiteBookingWorkflowFinish> {
  finish(input: InputOf<OffsiteBookingWorkflowFinish>): OutputOf<OffsiteBookingWorkflowFinish> {
    const venue = input.venue.value;
    const flights = input.flights.value;
    const venueLine = `venue ${venue.venue}: ${venue.isBooked ? "booked" : "declined"}`;
    const flightsLine = `flights ${flights.route}: ${flights.isBooked ? "booked" : "declined"}`;
    return { summary: `${venueLine}; ${flightsLine}` };
  }
}
