import { WorkflowStart } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";

/** Where an offsite's booking starts: what the team needs — a venue and flights, with prices. */
@WorkflowStart({
  name: "offsite-booking-workflow-start",
  description: "An offsite to book",
  input: WorkflowStartTextDto,
})
export class OffsiteBookingWorkflowStart {}
