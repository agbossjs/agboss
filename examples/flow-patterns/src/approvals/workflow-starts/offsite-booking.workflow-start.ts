import { WorkflowStart } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";

/** Where an offsite's booking starts: what the team needs — a venue and flights, with prices. */
@WorkflowStart({
  name: "offsite-booking-workflow-start",
  description: "An offsite to book",
  input: WorkflowStartTextDto,
})
export class OffsiteBookingWorkflowStart {}
