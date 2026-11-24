/** The workflows of an agent chain, a DTO agent, a parallel launch (#1004, #1006, #1007). */
import { EmptyEnvironment, Workflow, WorkflowFinish, WorkflowStart } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { Closer, Editor, LaunchColor, LaunchShape, ShapeDto, Shaper } from "./agents.fixture.js";

@WorkflowStart({ name: "chain-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class ChainStart {}

@WorkflowFinish({
  name: "chain-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class ChainFinish {}

/** A chain: an agent with an output DTO, then a text agent that reads it. */
@Workflow({
  name: "chain-workflow",
  version: "1.0.0",
  flow: [onStart(ChainStart).toAgent(Shaper).toAgent(Editor).toFinish(ChainFinish)],
  defaults: { models: { temperature: 0, maxTokens: 1000 } },
})
class ChainWorkflow {}

@WorkflowStart({ name: "shape-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class ShapeStart {}

@WorkflowFinish({ name: "shape-workflow-finish", description: "Reply", output: ShapeDto })
class ShapeFinish {}

@Workflow({
  name: "shape-workflow",
  version: "1.0.0",
  flow: [onStart(ShapeStart).toAgent(Shaper).toFinish(ShapeFinish)],
  defaults: { models: { temperature: 0, maxTokens: 1000 } },
})
class ShapeWorkflow {}

@WorkflowStart({
  name: "launch-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class LaunchStart {}

@WorkflowFinish({
  name: "launch-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class LaunchFinish {}

/** Two branches in parallel (one judged), then a text agent. */
@Workflow({
  name: "launch-workflow",
  version: "1.0.0",
  flow: [
    onStart(LaunchStart)
      .toParallelAgents(LaunchShape, LaunchColor)
      .join()
      .toAgent(Closer)
      .toFinish(LaunchFinish),
  ],
  defaults: { models: { temperature: 0, maxTokens: 1000 } },
})
class LaunchWorkflow {}

@Application({
  name: "stream-flow-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChainWorkflow, ShapeWorkflow, LaunchWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class StreamFlowApplication {}
