import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { CompanyGradeDto } from "./child-dtos.js";
import {
  CompanyGradedWorkflowFinish,
  CompanyPickerAgent,
  JobOfferAgent,
  JobOfferWorkflowFinish,
} from "./children.fixture.js";
import { CompanyDto } from "./data-dtos.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { onAgent, onStart } from "./paths.js";
import { inline } from "../../../src/index.js";

/**
 * #263 — a child with two starts that take one class (`[graph.ambiguous-start]`): its generated
 * `InputOf` is the rule's message, so the typed builder refuses `.toWorkflow(TwinGradeWorkflow)`.
 * Written with the untyped helpers — the typed builder would not let it compile.
 */

@WorkflowStart({
  name: "quick-grade-workflow-start",
  description: "A quick grade of a company",
  input: CompanyDto,
})
export class QuickGradeWorkflowStart {}

@WorkflowStart({
  name: "full-grade-workflow-start",
  description: "A full grade of a company",
  input: CompanyDto,
})
export class FullGradeWorkflowStart {}

@Agent({
  name: "company-grader-agent",
  description: "Grades one company",
  prompt: inline("Grade the company."),
  model: "moonshotai/kimi-k2.6",
  input: { company: CompanyDto },
  output: CompanyGradeDto,
})
export class CompanyGraderAgent {}

@Workflow({
  name: "twin-grade-workflow",
  version: "1.0.0",
  flow: [
    onStart(QuickGradeWorkflowStart).toAgent(CompanyGraderAgent),
    onStart(FullGradeWorkflowStart).toAgent(CompanyGraderAgent),
    onAgent(CompanyGraderAgent).toFinish(CompanyGradedWorkflowFinish),
  ],
})
export class TwinGradeWorkflow {}

@WorkflowStart({
  name: "broken-review-workflow-start",
  description: "Who to make an offer for",
  input: WorkflowStartTextDto,
})
export class BrokenReviewWorkflowStart {}

@Workflow({
  name: "broken-review-workflow",
  version: "1.0.0",
  flow: [
    onStart(BrokenReviewWorkflowStart)
      .toAgent(CompanyPickerAgent)
      .toWorkflow(TwinGradeWorkflow)
      .toAgent(JobOfferAgent)
      .toFinish(JobOfferWorkflowFinish),
  ],
})
export class BrokenReviewWorkflow {}
