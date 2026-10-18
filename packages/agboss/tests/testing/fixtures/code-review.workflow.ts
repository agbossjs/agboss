import {
  Agent,
  DecidedBy,
  Injectable,
  MODEL_MAX,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { Reasoning } from "../../../src/models/index.js";
import { agent, route, start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

const price = { inputPerMTok: 1, outputPerMTok: 2 };

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
  promptUrls: ["./coder.prompt.md"],
  description: "Writes the code",
  model: "test/coder",
  price,
  input: { task: WorkflowStartTextDto, review: optional(ReviewDto) },
  output: CodeDto,
})
export class Coder {}

@Agent({
  name: "reviewer-agent",
  promptUrls: ["./reviewer.prompt.md"],
  description: "Reviews the code",
  model: "test/reviewer",
  price,
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
  prompt: "Is the review clean?",
  model: "typesafe/jev-1.13",
  input: { review: ReviewDto },
  maxVisits: 3,
  routes: [
    { prompt: "The review asks for changes", target: Coder },
    { prompt: "Stop and send the change: the review is clean", target: PullRequest },
  ],
})
export class ReviewGate {}

/** A class the workflow never uses (mockOf of it is a test setup error). */
@Injectable()
export class Unused {}

/** The code-review cycle: the gate sends the code back to the coder until the review is clean. */
@Workflow({
  name: "code-review-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Coder),
    agent(Coder)
      .returns(CodeDto)
      .toAgent(Reviewer)
      .returns(ReviewDto, { about: CodeDto }) // the review is about this code (#271)
      .toRouter(ReviewGate)
      .chooseOne(route(Coder), route(PullRequest)),
  ],
  defaults: {
    models: {
      temperature: 0,
      maxTokens: MODEL_MAX,
      reasoning: Reasoning.modelDecides(),
      cache: true,
    },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
    history: { limit: 2 },
  },
})
export class CodeReview {}

@Application({
  name: "code-review-application",
  version: "1.0.0",
  workflows: [CodeReview],
  budgets: TEST_BUDGETS,
})
export class CodeReviewApplication {}
