import { WorkflowFinish } from "@agboss/core";
import { TripRequestDto } from "../dtos/trip.dto.js";

/** The trip could not be booked: what was booked of it was cancelled — the request. */
@WorkflowFinish({
  name: "trip-not-booked-workflow-finish",
  description: "The trip was not booked",
  output: TripRequestDto,
})
export class TripNotBookedWorkflowFinish {}
