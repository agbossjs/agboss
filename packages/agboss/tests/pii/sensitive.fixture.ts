/** `sensitive` fields and context fields, a model router, a model detection (#120 AC3, AC8, AC13). */
import {
  Agent,
  DecidedBy,
  ExecutionContext,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  secret,
  inline,
  Ttl,
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toAgent, toFinish } from "../helpers/flow.js";
import { ContactPiiPolicy, PII_KEY_VARIABLE } from "./pii.fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../src/testing/test-model-provider.js";

/** Who the execution talks to: identity, marked for PII. */
export class ShopExecutionContext extends ExecutionContext {
  @Text({ optional: true, sensitive: PiiAction.tokenize() })
  userId?: string;
}

/**
 * What a desk run starts with: the framework's text and `author` (masked one-way, #1301), and a
 * `reporter` the project marks for a token the model can write back (#1007 AC4).
 */
export class DeskMessageDto {
  @Text({ prompt: "the text the run starts with", minLength: 1 })
  text!: string;

  @Text({ prompt: "who sent it", optional: true, sensitive: PiiAction.mask() })
  author?: string;

  @Text({ prompt: "who reported it", optional: true, sensitive: PiiAction.tokenize() })
  reporter?: string;
}

@PiiPolicy({
  name: "names-pii-policy",
  description: "Finds names with a model",
  rules: [PiiKind.PersonName.mask()],
  model: "test/pii-detector",
  secret: secret(PII_KEY_VARIABLE),
})
export class NamesPiiPolicy {}

@Agent({
  name: "desk-agent",
  description: "Answers",
  prompt: inline("Answer."),
  input: { message: DeskMessageDto },
  model: "test/desk",
  piiPolicies: [NamesPiiPolicy],
})
export class DeskAgent {}

@WorkflowStart({
  name: "desk-workflow-start",
  description: "A message",
  input: DeskMessageDto,
})
export class DeskStart {}

@WorkflowFinish({
  name: "desk-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class DeskFinish {}

@WorkflowFinish({
  name: "hand-over-workflow-finish",
  description: "Handed over as is",
  output: DeskMessageDto,
})
export class HandOverFinish {}

@Router({
  name: "desk-router",
  description: "Sends the message on",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick who answers."),
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  input: { message: DeskMessageDto },
  maxVisits: 1,
  routes: [
    { prompt: "A question", target: DeskAgent },
    { prompt: "Stop and hand the message over: it is no question", target: HandOverFinish },
  ],
})
export class DeskRouter {}

@Workflow({
  name: "sensitive-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DeskStart)
      .toRouter(DeskRouter)
      .onRoute(toAgent(DeskAgent).toFinish(DeskFinish))
      .onRoute(toFinish(HandOverFinish)),
  ],
  defaults: { models: { temperature: 0 } },
})
export class SensitiveWorkflow {}

@Application({
  name: "sensitive-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [SensitiveWorkflow],
  executionContext: ShopExecutionContext,
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class SensitiveApplication {}
