import { Window2Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  DecidedBy,
  Injectable,
  TokenLimit,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { Reasoning } from "../../../src/models/index.js";
import { onAgent, onStart, toAgent, toFinish } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";
import { usd } from "../../../src/units/index.js";

/** The coder's change. */
export class CodeDto {
  @Text({ prompt: "the change" })
  text!: string;
}

/** The reviewer's verdict. */
export class ReviewDto {
  @Text({ prompt: "the review" })
  text!: string;
}

@Agent({
  name: "coder-agent",
  prompt: "./coder.prompt.md",
  description: "Writes the code",
  model: "test/coder",
  input: { task: WorkflowStartTextDto, review: optional(ReviewDto) },
  output: CodeDto,
})
export class Coder {}

@Agent({
  name: "reviewer-agent",
  prompt: "./reviewer.prompt.md",
  description: "Reviews the code",
  model: "test/reviewer",
  input: { code: CodeDto },
  output: ReviewDto,
})
export class Reviewer {}

@WorkflowStart({
  name: "task-workflow-start",
  description: "A coding task",
  input: WorkflowStartTextDto,
})
export class TaskStart {}

@WorkflowFinish({
  name: "pull-request-workflow-finish",
  description: "The change",
  output: CodeDto,
})
export class PullRequest {}

@Router({
  name: "review-gate-router",
  description: "Sends the code back to the coder or opens the pull request",
  decidedBy: DecidedBy.Model,
  prompt: inline("Is the review clean?"),
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  input: { review: ReviewDto },
  maxVisits: 3,
  routes: [
    { prompt: "The review asks for changes", target: Coder },
    { prompt: "Stop and send the change: the review is clean", target: PullRequest },
  ],
})
export class ReviewGate {}

/** A class the workflow never uses (mockService of it is a test setup error). */
@Injectable()
export class Unused {}

/** The code-review cycle: the gate sends the code back to the coder until the review is clean. */
@Workflow({
  name: "code-review-workflow",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(TaskStart)
      .toAgent(Coder),
    onAgent(Coder)
      .toAgent(Reviewer) // the review is about this code (#271)
      .toRouter(ReviewGate)
      .onRoute(toAgent(Coder))
      .onRoute(toFinish(PullRequest)),
  ],
  defaults: {
    models: {
      temperature: 0,
      maxTokens: TokenLimit.ModelMax,
      reasoning: Reasoning.modelDecides(),
      cache: true,
    },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
  },
  memory: Window2Memory,
})
export class CodeReview {}

@Application({
  name: "code-review-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [CodeReview],
  budgets: TEST_BUDGETS,
})
export class CodeReviewApplication {}
