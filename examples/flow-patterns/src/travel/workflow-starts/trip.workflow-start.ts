import { WorkflowStart } from "@agboss/core";
import { TripRequestDto } from "../dtos/trip.dto.js";

/** Where booking a trip starts: the destination and the nights. */
@WorkflowStart({
  name: "trip-workflow-start",
  description: "A trip to book",
  input: TripRequestDto,
})
export class TripWorkflowStart {}
