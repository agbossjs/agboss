/**
 * Two internal model kinds on a chat model, for the canary (#1004): an output guardrail and a
 * quorum arbiter. The guarded agent answers in text (its own call is heard); the quorum's agents
 * answer through an answer tool (they stream no text), so a canary in the stream is the arbiter's.
 */
import {
  Agent,
  Arbiter,
  DecidedBy,
  EmptyEnvironment,
  OutputGuardrail,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type Produced,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { MODEL_PROVIDERS } from "../judges/fixtures/judged.workflow.js";

@OutputGuardrail({
  name: "chat-guardrail",
  description: "Blocks an answer on a chat model",
  prompt: "Is the answer forbidden?",
  model: "local/llama",
  threshold: 0.8,
  refusal: "Refused.",
})
export class ChatGuardrail {}

@Agent({
  name: "guarded-text-agent",
  prompt: "Write.",
  description: "Writes",
  model: "local/llama",
  guardrails: [ChatGuardrail],
})
export class GuardedTextAgent {}

@WorkflowStart({
  name: "guarded-text-workflow-start",
  description: "A task",
  input: WorkflowStartTextDto,
})
export class GuardedTextStart {}

@WorkflowFinish({
  name: "guarded-text-workflow-finish",
  description: "Reply",
  output: WorkflowFinishTextDto,
})
class GuardedTextFinish {}

@Workflow({
  name: "guarded-text-workflow",
  version: "1.0.0",
  flow: [
    start(GuardedTextStart)
      .returns(WorkflowStartTextDto)
      .toAgent(GuardedTextAgent)
      .toFinish(GuardedTextFinish),
  ],
  defaults: { models: { temperature: 0, maxTokens: 1000 } },
})
class GuardedTextWorkflow {}

export class OwnerDto {
  @Text({ prompt: "who owns the rota" })
  owner!: string;
}

export class OwnersDto {
  @Text({ prompt: "the owners named" })
  owners!: string;
}

@Agent({
  name: "owner-answer-agent",
  description: "Names the rota's owner",
  prompt: "Name the owner.",
  model: "local/llama",
  output: OwnerDto,
})
export class OwnerAgent {}

@Arbiter({
  name: "chat-arbiter",
  decidedBy: DecidedBy.Model,
  model: "local/llama",
  prompt: "Count an answer that names an owner.",
  criteria: [{ agent: OwnerAgent, prompt: "Names the owner" }],
})
export class ChatArbiter {}

@WorkflowStart({
  name: "owners-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class OwnersStart {}

@WorkflowFinish({
  name: "owners-workflow-finish",
  description: "The owners",
  input: { answers: listOf(OwnerDto) },
  output: OwnersDto,
})
class OwnersFinish {
  finish(input: { readonly answers: readonly Produced<OwnerDto, unknown>[] }): OwnersDto {
    return { owners: input.answers.map((answer) => answer.value.owner).join("; ") };
  }
}

@Workflow({
  name: "owners-quorum-workflow",
  version: "1.0.0",
  flow: [
    start(OwnersStart)
      .returns(WorkflowStartTextDto)
      .toParallelAgents(OwnerAgent, OwnerAgent)
      .acceptedBy(ChatArbiter)
      .joinQuorum({ min: 2 })
      .returns(listOf(OwnerDto))
      .toFinish(OwnersFinish),
  ],
})
class OwnersWorkflow {}

@Application({
  name: "internal-kinds-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [GuardedTextWorkflow, OwnersWorkflow],
  providers: MODEL_PROVIDERS,
  budgets: TEST_BUDGETS,
})
export class InternalKindsApplication {}
