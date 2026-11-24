import { WorkflowFinish } from "@agboss/core";
import { OffsiteBookingDto } from "../../dto/offsite-booking.dto.js";

/** Where an offsite's booking finishes: both buyers' answers, as one line each. */
@WorkflowFinish({
  name: "offsite-booking-workflow-finish",
  description: "What was booked",
  output: OffsiteBookingDto,
})
export class OffsiteBookingWorkflowFinish {}
