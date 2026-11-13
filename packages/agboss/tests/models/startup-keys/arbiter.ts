import {
  Agent,
  Arbiter,
  DecidedBy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Class,
  type Produced,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { start } from "../../helpers/flow.js";

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
    decidedBy: DecidedBy.Model,
    model,
    prompt: "Count it.",
    criteria: [{ agent: AnsAgent, prompt: "ok" }],
  })
  class AnsArbiter {}
  @WorkflowStart({
    name: "ans-start-workflow-start",
    description: "q",
    input: WorkflowStartTextDto,
  })
  class AnsStart {}
  @WorkflowFinish({
    name: "ans-finish-workflow-finish",
    description: "f",
    input: { answers: listOf(AnswerDto) },
    output: WorkflowFinishTextDto,
  })
  class AnsFinish {
    finish(i: {
      readonly answers: readonly Produced<AnswerDto, unknown>[];
    }): WorkflowFinishTextDto {
      return { text: String(i.answers.length) };
    }
  }
  @Workflow({
    name: "ans-workflow",
    version: "1.0.0",
    flow: [
      start(AnsStart)
        .returns(WorkflowStartTextDto)
        .toParallelAgents(AnsAgent, AnsAgent)
        .acceptedBy(AnsArbiter)
        .joinQuorum({ min: 2 })
        .returns(listOf(AnswerDto))
        .toFinish(AnsFinish),
    ],
  })
  class AnsWorkflow {}
  return AnsWorkflow;
}
