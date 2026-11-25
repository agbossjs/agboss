import {
  Agent,
  Arbiter,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Class,
  type Tracked,
  Action,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { onStart, toAgent } from "../../helpers/flow.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

export class AnswerDto {
  @Text({ prompt: "an answer" })
  answer!: string;
}

/** Two copies of a local agent, accepted by a model arbiter on `model`. */
export function arbiterWorkflow(model: string): Class {
  @Agent({
    name: "ans-agent",
    description: "A",
    prompt: inline("A."),
    model: "local/llama",
    output: AnswerDto,
  })
  class AnsAgent {}
  @Arbiter({
    name: "ans-arbiter",
    model,
    prompt: inline("Count it."),
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
      readonly answers: readonly Tracked<AnswerDto>[];
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
    modelProvider: TestModelProvider,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(AnsStart)
        .inParallel([toAgent(AnsAgent), toAgent(AnsAgent)])
        .arbitratedBy(AnsArbiter)
        .joinQuorum({ min: 2 })
        .toAction(AnsAction)
        .toFinish(AnsFinish),
    ],
  })
  class AnsWorkflow {}
  return AnsWorkflow;
}
