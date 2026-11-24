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
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { route, onStart } from "../helpers/flow.js";
import { ContactPiiPolicy, PII_KEY_VARIABLE } from "./pii.fixture.js";

/** Who the execution talks to: identity, marked for PII. */
export class ShopExecutionContext extends ExecutionContext {
  @Text({ optional: true, sensitive: PiiAction.tokenize() })
  userId?: string;
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
  model: "test/desk",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  piiPolicies: [NamesPiiPolicy],
})
export class DeskAgent {}

@WorkflowStart({
  name: "desk-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
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
  output: WorkflowStartTextDto,
})
export class HandOverFinish {}

@Router({
  name: "desk-router",
  description: "Sends the message on",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick who answers."),
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto },
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
  flow: [
    onStart(DeskStart)
      .toRouter(DeskRouter)
      .chooseOne(route(DeskAgent).toFinish(DeskFinish), route(HandOverFinish)),
  ],
  defaults: { models: { temperature: 0 } },
})
export class SensitiveWorkflow {}

@Application({
  name: "sensitive-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SensitiveWorkflow],
  executionContext: ShopExecutionContext,
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class SensitiveApplication {}
