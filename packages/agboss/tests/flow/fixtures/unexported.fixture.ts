import { Text } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { onStart } from "./paths.js";

/** #272 S2 — a component and a DTO the generated types need but no module exports. */

class HiddenDto {
  @Text({ prompt: "anything" })
  text!: string;
}

@WorkflowStart({ name: "hidden-workflow-start", description: "Anything", input: HiddenDto })
export class HiddenWorkflowStart {}

@Agent({
  name: "hidden-agent",
  description: "Not exported",
  prompt: "Do it.",
  model: "moonshotai/kimi-k2.6",
  input: {
    text: HiddenDto,
  },
  output: HiddenDto,
})
class HiddenAgent {}

@WorkflowFinish({ name: "hidden-workflow-finish", description: "Anything", output: HiddenDto })
export class HiddenWorkflowFinish {}

@Workflow({
  name: "hidden-workflow",
  version: "1.0.0",
  flow: [
    onStart(HiddenWorkflowStart)
      .toAgent(HiddenAgent)
      .toFinish(HiddenWorkflowFinish),
  ],
})
export class HiddenWorkflow {}
