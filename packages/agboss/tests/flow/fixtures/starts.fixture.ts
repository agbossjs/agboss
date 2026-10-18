import { start } from "../../../src/flow/builder.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import { CompanyDto, CompanyScoreDto, SearchRequestDto } from "./data-dtos.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** #270 AC20 / AC21 — a start's input as a map of fields and as a list. */

@WorkflowStart({
  name: "company-check-workflow-start",
  description: "A company to check, with the search's criteria or without",
  input: {
    company: CompanyDto,
    request: optional(SearchRequestDto),
  },
})
export class CompanyCheckWorkflowStart {}

@WorkflowStart({
  name: "company-batch-workflow-start",
  description: "A batch of companies to check",
  input: listOf(CompanyDto),
})
export class CompanyBatchWorkflowStart {}

@Agent({
  name: "company-check-agent",
  description: "Scores one company",
  prompt: "Score the company.",
  model: "moonshotai/kimi-k2.6",
  input: {
    company: CompanyDto,
    request: optional(SearchRequestDto),
  },
  output: CompanyScoreDto,
})
export class CompanyCheckAgent {}

@Agent({
  name: "batch-rank-agent",
  description: "Ranks a batch of companies",
  prompt: "Rank the companies.",
  model: "moonshotai/kimi-k2.6",
  input: {
    companies: listOf(CompanyDto),
  },
  output: CompanyScoreDto,
})
export class BatchRankAgent {}

@WorkflowFinish({
  name: "company-score-workflow-finish",
  description: "The score",
  output: CompanyScoreDto,
})
export class CompanyScoreWorkflowFinish {}

export const startsPaths = [
  start(CompanyCheckWorkflowStart)
    .returns(CompanyDto)
    .returns(optional(SearchRequestDto))
    .toAgent(CompanyCheckAgent)
    .returns(CompanyScoreDto)
    .toFinish(CompanyScoreWorkflowFinish),
  start(CompanyBatchWorkflowStart)
    .returns(listOf(CompanyDto))
    .toAgent(BatchRankAgent)
    .returns(CompanyScoreDto)
    .toFinish(CompanyScoreWorkflowFinish),
] as const;

@Workflow({
  name: "company-check-workflow",
  version: "1.0.0",
  flow: startsPaths,
})
export class CompanyCheckWorkflow {}

@Application({
  name: "company-check-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CompanyCheckWorkflow],
  budgets: TEST_BUDGETS,
})
export class CompanyCheckApplication {}
