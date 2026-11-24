import {
  Agent,
  Arbiter,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Class,
  type Produced,
  Action,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { onStart } from "../../helpers/flow.js";

export class AnswerDto {
  @Text({ prompt: "an answer" })
  answer!: string;
}

/** Two copies of a local agent, accepted by a model arbiter on `model`. */
export function arbiterWorkflow(model: string): Class {
  @Agent({
    name: "ans-agent",
    description: "A",
    prompt: "A.",
    model: "local/llama",
    output: AnswerDto,
  })
  class AnsAgent {}
  @Arbiter({
    name: "ans-arbiter",
    model,
    prompt: "Count it.",
    criteria: [{ target: AnsAgent, prompt: "ok" }],
  })
  class AnsArbiter {}
  @WorkflowStart({
    name: "ans-start-workflow-start",
    description: "q",
    input: WorkflowStartTextDto,
  })
  class AnsStart {}
  @Action({
    name: "ans-finish-action",
    description: "f",
    input: { answers: listOf(AnswerDto) },
    output: WorkflowFinishTextDto,
  })
  class AnsAction {
    async execute(i: {
      readonly answers: readonly Produced<AnswerDto, unknown>[];
    }): Promise<WorkflowFinishTextDto> {
      return { text: String(i.answers.length) };
    }
  }

  @WorkflowFinish({
    name: "ans-finish-workflow-finish",
    description: "f",
    output: WorkflowFinishTextDto,
  })
  class AnsFinish {}
  @Workflow({
    name: "ans-workflow",
    version: "1.0.0",
    flow: [
      onStart(AnsStart)
        .toParallelAgents(AnsAgent, AnsAgent)
        .arbitratedBy(AnsArbiter)
        .joinQuorum({ min: 2 })
        .toAction(AnsAction)
        .toFinish(AnsFinish),
    ],
  })
  class AnsWorkflow {}
  return AnsWorkflow;
}
