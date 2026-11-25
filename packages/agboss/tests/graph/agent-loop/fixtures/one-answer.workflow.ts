import { Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { onStart } from "../../../helpers/flow.js";
import { CircuitBreakerPolicy } from "../../../../src/models/circuit-breaker-policy.js";

/**
 * #649 — an agent whose only tool is its answer tool, on a real OpenAI-compatible HTTP provider: it
 * answers with one call, so its requests say `parallel_tool_calls: false`. Beside it an agent with a
 * tool of its own, whose parallel calls are its loop's to run.
 */

export class LegalReviewDto {
  @Text({ prompt: "the contract clause the review rests on" })
  clause!: string;
}

export class ClauseQueryDto {
  @Text({ prompt: "the clause's number" })
  number!: string;
}

@Tool({
  name: "clause-text-tool",
  description: "The text of a contract clause",
  input: ClauseQueryDto,
  output: LegalReviewDto,
})
export class ClauseTextTool {
  execute({ number }: ClauseQueryDto): Promise<LegalReviewDto> {
    return Promise.resolve({ clause: `clause ${number}` });
  }
}

@Agent({
  name: "legal-review-agent",
  description: "Reviews the contract",
  prompt: inline("Cite the contract clause your review rests on."),
  model: "wire/model",
  input: { message: WorkflowStartTextDto },
  output: LegalReviewDto,
})
export class LegalReviewAgent {}

@Agent({
  name: "clause-reader-agent",
  description: "Reviews the contract, reading its clauses",
  prompt: inline("Read the clauses you need, then cite the one your review rests on."),
  model: "wire/model",
  input: { message: WorkflowStartTextDto },
  output: LegalReviewDto,
  tools: [ClauseTextTool],
})
export class ClauseReaderAgent {}

@WorkflowStart({
  name: "review-workflow-start",
  description: "A contract",
  input: WorkflowStartTextDto,
})
export class ReviewWorkflowStart {}

@WorkflowStart({
  name: "reading-workflow-start",
  description: "A contract, read clause by clause",
  input: WorkflowStartTextDto,
})
export class ReadingWorkflowStart {}

@WorkflowFinish({
  name: "review-workflow-finish",
  description: "The review",
  output: LegalReviewDto,
})
export class ReviewWorkflowFinish {}

@WorkflowFinish({
  name: "reading-workflow-finish",
  description: "The review, read",
  output: LegalReviewDto,
})
export class ReadingWorkflowFinish {}

@Workflow({
  name: "review-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ReviewWorkflowStart)
    .toAgent(LegalReviewAgent)
    .toFinish(ReviewWorkflowFinish)],
})
export class ReviewWorkflow {}

@Workflow({
  name: "reading-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ReadingWorkflowStart)
    .toAgent(ClauseReaderAgent)
    .toFinish(ReadingWorkflowFinish)],
})
export class ReadingWorkflow {}

@ModelProvider({
  name: "wire-model-provider",
  description: "An OpenAI-compatible server, stubbed",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://wire.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "wire/model": { inputPerMillion: usd(1), outputPerMillion: usd(1) },
  }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 50,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
})
export class WireModelProvider {}

@Application({
  name: "one-answer-application",
  modelProvider: WireModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ReviewWorkflow, ReadingWorkflow],
  providers: [WireModelProvider],
  budgets: TEST_BUDGETS,
})
export class OneAnswerApplication {}
