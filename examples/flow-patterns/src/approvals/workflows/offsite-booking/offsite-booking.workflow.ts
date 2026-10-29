import { start, Workflow } from "@agboss/core";
import { WorkflowStartTextDto } from "@agboss/core/dto";
import { FlightBuyerAgent } from "../../agents/flight-buyer/flight-buyer.agent.js";
import { VenueBuyerAgent } from "../../agents/venue-buyer/venue-buyer.agent.js";
import { FlightBookingDto } from "../../dto/flight-booking.dto.js";
import { VenueBookingDto } from "../../dto/venue-booking.dto.js";
import { ApprovalTerminal } from "../../services/approval-terminal.service.js";
import { OffsiteBookingWorkflowFinish } from "./offsite-booking.workflow-finish.js";
import { OffsiteBookingWorkflowStart } from "./offsite-booking.workflow-start.js";

/**
 * Two approvals at once (#267): the venue buyer and the flight buyer run side by side, and each
 * calls place-purchase-tool, which waits for the thread's owner through `PurchaseApprovalChannel`. So the
 * execution rests with two pauses (`result.pending`); each answer continues its own branch, and the
 * join waits for both. The pauses are records in SQLite (`SqlitePausedExecutionRepository`, the
 * checkpoints in `SqliteCheckpointSaver`): they wait across a restart of the process.
 */
@Workflow({
  name: "offsite-booking-workflow",
  version: "1.0.0",
  flow: [
    start(OffsiteBookingWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(VenueBuyerAgent, FlightBuyerAgent)
      .join()
      .returns(VenueBookingDto)
      .returns(FlightBookingDto)
      .toFinish(OffsiteBookingWorkflowFinish),
  ],
  providers: [ApprovalTerminal], // what the terminal channel prints on
})
export class OffsiteBookingWorkflow {}
