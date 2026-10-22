// `agboss check` fixture (#371): a workflow with its own FlightBookingDto — the other has one too
// the untyped builder: this package has no generated types for the framework's fixtures
import { start } from "../../../../../agboss/tests/flow/fixtures/paths.js";
import { Workflow } from "../../../../../agboss/src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../../agboss/src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../../agboss/src/flow/decorators/workflow-start.js";
import { Text } from "../../../../../agboss/src/dto/index.js";

// declared next to the start: the check loads the components' files (its types import it from here)
export class FlightBookingDto {
  @Text({ prompt: "the flight booked" })
  flight!: string;
}

@WorkflowStart({ name: "approvals-workflow-start", description: "An approval", input: FlightBookingDto })
export class ApprovalsWorkflowStart {}

@WorkflowFinish({ name: "approvals-workflow-finish", description: "Booked", output: FlightBookingDto })
export class ApprovalsWorkflowFinish {}

@Workflow({
  name: "approvals-workflow",
  version: "1.0.0",
  flow: [
    start(ApprovalsWorkflowStart)
      .returns(FlightBookingDto)
      .toFinish(ApprovalsWorkflowFinish),
  ],
})
export class ApprovalsWorkflow {}
