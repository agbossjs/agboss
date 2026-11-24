import { WorkflowFinish } from "@agboss/core";
import { TripBookedDto } from "../../dto/trip.dto.js";

/** Where a booked trip finishes — and commits both bookings: nothing undoes them any more. */
@WorkflowFinish({
  name: "trip-booked-workflow-finish",
  description: "The flight and the hotel, booked",
  output: TripBookedDto,
})
export class TripBookedWorkflowFinish {}
