/** The workflows with child workflows: one child, and one per item in parallel (#1004, #1006). */
import {
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Produced,
  Action,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";
import { ChildWriter } from "./agents.fixture.js";

@WorkflowStart({
  name: "child-writer-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
class ChildStart {}

@WorkflowFinish({
  name: "child-writer-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class ChildFinish {}

/** A child workflow that ends with a text agent. */
@Workflow({
  name: "child-writer-workflow",
  version: "1.0.0",
  flow: [onStart(ChildStart).toAgent(ChildWriter).toFinish(ChildFinish)],
  defaults: { models: { temperature: 0, maxTokens: 1000 } },
})
class ChildWriterWorkflow {}

@WorkflowStart({ name: "once-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class OnceStart {}

@WorkflowFinish({
  name: "once-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class OnceFinish {}

/** One child run. */
@Workflow({
  name: "once-workflow",
  version: "1.0.0",
  flow: [onStart(OnceStart).toWorkflow(ChildWriterWorkflow).toFinish(OnceFinish)],
})
class OnceWorkflow {}

@WorkflowStart({
  name: "fan-workflow-start",
  description: "The tasks",
  input: listOf(WorkflowStartTextDto),
})
export class FanStart {}

@Action({
  name: "fan-action",
  description: "The answers",
  input: { answers: listOf(WorkflowFinishTextDto) },
  output: WorkflowFinishTextDto,
})
class FanAction {
  async execute(input: {
    readonly answers: readonly Produced<WorkflowFinishTextDto, unknown>[];
  }): Promise<WorkflowFinishTextDto> {
    return { text: input.answers.map((answer) => answer.value.text).join(" | ") };
  }
}

@WorkflowFinish({
  name: "fan-workflow-finish",
  description: "The answers",
  output: WorkflowFinishTextDto,
})
class FanFinish {}

/** One child per item, in parallel. */
@Workflow({
  name: "fan-workflow",
  version: "1.0.0",
  flow: [
    onStart(FanStart)
      .toParallelWorkflows(ChildWriterWorkflow, { maxItems: 4 })
      .join()
      .toAction(FanAction)
      .toFinish(FanFinish),
  ],
})
class FanWorkflow {}

@Application({
  name: "stream-children-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OnceWorkflow, FanWorkflow, ChildWriterWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class StreamChildrenApplication {}
