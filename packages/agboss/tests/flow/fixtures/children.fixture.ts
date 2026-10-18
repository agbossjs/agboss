import {
  action,
  agent,
  caseOf,
  start,
  toAction,
  toFinish,
  workflow,
} from "../../../src/flow/builder.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  CompanyGradeDto,
  CompanyLinkDto,
  CompanyRejectedDto,
  CompanyReviewFailedDto,
  DeepDiveDto,
  GradedShortlistDto,
  JobOfferDto,
  PromisingCompanyDto,
} from "./child-dtos.js";
import { CompanyDto } from "./data-dtos.js";
import { WorkflowStartTextDto } from "./dtos.js";

/**
 * #263 — the issue's child workflow and its three parents: one child per item of a list, one child
 * continued inline, and one child reached from two places (its own path). They pass the analyser;
 * their runtime is #263 PR 2.
 */

// ── the child: one company, its own chain and branches ──

@WorkflowStart({
  name: "company-review-workflow-start",
  description: "One company to review",
  input: CompanyDto,
})
export class CompanyReviewWorkflowStart {}

@WorkflowStart({
  name: "company-link-review-workflow-start",
  description: "Review a company by a link",
  input: CompanyLinkDto,
})
export class CompanyLinkReviewWorkflowStart {}

@Agent({
  name: "company-reviewer-agent",
  description: "Decides whether the company is worth a deep dive",
  prompt: "Review the company.",
  model: "moonshotai/kimi-k2.6",
  input: { company: optional(CompanyDto), link: optional(CompanyLinkDto) },
  output: oneOf(PromisingCompanyDto, CompanyRejectedDto),
})
export class CompanyReviewerAgent {}

@Agent({
  name: "deep-dive-agent",
  description: "Looks deeper into a promising company",
  prompt: "Dive into the company.",
  model: "moonshotai/kimi-k2.6",
  input: { promising: PromisingCompanyDto },
  output: DeepDiveDto,
})
export class DeepDiveAgent {}

@Agent({
  name: "grader-agent",
  description: "Grades the company",
  prompt: "Grade the company.",
  model: "moonshotai/kimi-k2.6",
  input: { deepDive: DeepDiveDto },
  output: CompanyGradeDto,
})
export class GraderAgent {}

@Action({
  name: "mark-review-failed-action",
  description: "Records that a promising company could not be reviewed",
  input: { promising: PromisingCompanyDto },
  output: CompanyReviewFailedDto,
})
export class MarkReviewFailedAction implements ActionHandler<MarkReviewFailedAction> {
  execute(input: InputOf<MarkReviewFailedAction>): Promise<OutputOf<MarkReviewFailedAction>> {
    return Promise.resolve({ reason: `the review failed after: ${input.promising.value.reason}` });
  }
}

@WorkflowFinish({
  name: "company-graded-workflow-finish",
  description: "The company is graded",
  output: CompanyGradeDto,
})
export class CompanyGradedWorkflowFinish {}

@WorkflowFinish({
  name: "company-rejected-workflow-finish",
  description: "The company is not a fit",
  output: CompanyRejectedDto,
})
export class CompanyRejectedWorkflowFinish {}

@WorkflowFinish({
  name: "company-review-failed-workflow-finish",
  description: "The company could not be reviewed",
  output: CompanyReviewFailedDto,
})
export class CompanyReviewFailedWorkflowFinish {}

@Workflow({
  name: "company-review-workflow",
  version: "1.0.0",
  flow: [
    start(CompanyReviewWorkflowStart)
      .returns(CompanyDto)
      .toAgent(CompanyReviewerAgent),

    start(CompanyLinkReviewWorkflowStart)
      .returns(CompanyLinkDto)
      .toAgent(CompanyReviewerAgent),

    // two ways in (two starts) → its own path
    agent(CompanyReviewerAgent)
      .returns(oneOf(PromisingCompanyDto, CompanyRejectedDto))
      .switch(
        caseOf(PromisingCompanyDto)
          .toAgent(DeepDiveAgent)
          .onError(StepFailedError, toAction(MarkReviewFailedAction))
          .returns(DeepDiveDto)
          .toAgent(GraderAgent)
          .onError(StepFailedError, toAction(MarkReviewFailedAction))
          .returns(CompanyGradeDto)
          .toFinish(CompanyGradedWorkflowFinish),
        caseOf(CompanyRejectedDto)
          .toFinish(CompanyRejectedWorkflowFinish),
      ),

    // two ways in (two onError side paths) → its own path: the soft failure of a per-item child
    action(MarkReviewFailedAction)
      .returns(CompanyReviewFailedDto)
      .toFinish(CompanyReviewFailedWorkflowFinish),
  ],
  maxSteps: 10,
})
export class CompanyReviewWorkflow {}

// ── a parent, per item: the child on every company, at most three at once ──

@WorkflowStart({
  name: "company-screening-workflow-start",
  description: "What to look for",
  input: WorkflowStartTextDto,
})
export class CompanyScreeningWorkflowStart {}

@Agent({
  name: "company-finder-agent",
  description: "Finds the companies to review",
  prompt: "Find companies.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: listOf(CompanyDto),
})
export class CompanyFinderAgent {}

@Action({
  name: "notify-review-stopped-action",
  description: "Tells the operator that the reviews stopped on a limit",
  input: { companies: listOf(CompanyDto) },
})
export class NotifyReviewStoppedAction implements ActionHandler<NotifyReviewStoppedAction> {
  async execute(input: InputOf<NotifyReviewStoppedAction>): Promise<void> {
    await Promise.resolve(input.companies.length);
  }
}

@Agent({
  name: "review-ranker-agent",
  description: "Ranks the reviewed companies",
  prompt: "Rank the companies.",
  model: "moonshotai/kimi-k2.6",
  input: { reviews: listOf(oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto)) },
  output: GradedShortlistDto,
})
export class ReviewRankerAgent {}

@WorkflowFinish({
  name: "graded-shortlist-workflow-finish",
  description: "The shortlist",
  output: GradedShortlistDto,
})
export class GradedShortlistWorkflowFinish {}

@WorkflowFinish({
  name: "screening-stopped-workflow-finish",
  description: "The screening stopped on a limit: the request, handed back",
  output: WorkflowStartTextDto,
})
export class ScreeningStoppedWorkflowFinish {}

@Workflow({
  name: "company-screening-workflow",
  version: "1.0.0",
  flow: [
    start(CompanyScreeningWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CompanyFinderAgent)
      .returns(listOf(CompanyDto)) // each element enters company-review-workflow-start
      .toParallelWorkflows(CompanyReviewWorkflow, { maxConcurrency: 3, maxItems: 50 })
      .join()
      .onJoinError(
        LimitExceededError,
        toAction(NotifyReviewStoppedAction)
          .toFinish(ScreeningStoppedWorkflowFinish),
      )
      .returns(listOf(oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto)))
      .toAgent(ReviewRankerAgent)
      .returns(GradedShortlistDto)
      .toFinish(GradedShortlistWorkflowFinish),
  ],
})
export class CompanyScreeningWorkflow {}

// ── a parent, one child, one way in: errors right after .toWorkflow(W), one case per class ──

@WorkflowStart({
  name: "job-offer-workflow-start",
  description: "Who to make an offer for",
  input: WorkflowStartTextDto,
})
export class JobOfferWorkflowStart {}

@Agent({
  name: "company-picker-agent",
  description: "Picks the company of the request",
  prompt: "Pick the company.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: CompanyDto,
})
export class CompanyPickerAgent {}

@Agent({
  name: "job-offer-agent",
  description: "Writes the offer for a graded company",
  prompt: "Write the offer.",
  model: "moonshotai/kimi-k2.6",
  input: { grade: CompanyGradeDto },
  output: JobOfferDto,
})
export class JobOfferAgent {}

@WorkflowFinish({
  name: "job-offer-workflow-finish",
  description: "The offer",
  output: JobOfferDto,
})
export class JobOfferWorkflowFinish {}

@WorkflowFinish({
  name: "no-offer-rejected-workflow-finish",
  description: "No offer: the company is not a fit",
  output: CompanyRejectedDto,
})
export class NoOfferRejectedWorkflowFinish {}

@WorkflowFinish({
  name: "no-offer-failed-workflow-finish",
  description: "No offer: the company could not be reviewed",
  output: CompanyReviewFailedDto,
})
export class NoOfferFailedWorkflowFinish {}

@WorkflowFinish({
  name: "review-error-workflow-finish",
  description: "The review failed: the request, handed back",
  output: WorkflowStartTextDto,
})
export class ReviewErrorWorkflowFinish {}

@Workflow({
  name: "job-offer-workflow",
  version: "1.0.0",
  flow: [
    start(JobOfferWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CompanyPickerAgent)
      .returns(CompanyDto) // enters company-review-workflow-start
      .toWorkflow(CompanyReviewWorkflow)
      .onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish))
      .returns(oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto))
      .switch(
        caseOf(CompanyGradeDto)
          .toAgent(JobOfferAgent)
          .returns(JobOfferDto)
          .toFinish(JobOfferWorkflowFinish),
        caseOf(CompanyRejectedDto)
          .toFinish(NoOfferRejectedWorkflowFinish),
        caseOf(CompanyReviewFailedDto)
          .toFinish(NoOfferFailedWorkflowFinish),
      ),
  ],
})
export class JobOfferWorkflow {}

// ── a parent, one child reached from two places: the child's own path, errors right after it ──

@WorkflowStart({
  name: "picked-offer-workflow-start",
  description: "Who to make an offer for",
  input: WorkflowStartTextDto,
})
export class PickedOfferWorkflowStart {}

@WorkflowStart({
  name: "link-offer-workflow-start",
  description: "An offer for the company behind a link",
  input: { message: WorkflowStartTextDto, link: CompanyLinkDto },
})
export class LinkOfferWorkflowStart {}

@Workflow({
  name: "link-offer-workflow",
  version: "1.0.0",
  flow: [
    start(PickedOfferWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CompanyPickerAgent)
      .returns(CompanyDto) // enters company-review-workflow-start
      .toWorkflow(CompanyReviewWorkflow),

    start(LinkOfferWorkflowStart)
      .returns(WorkflowStartTextDto)
      .returns(CompanyLinkDto) // enters company-link-review-workflow-start
      .toWorkflow(CompanyReviewWorkflow),

    // two ways in → its own path
    workflow(CompanyReviewWorkflow)
      .onError(StepFailedError, toFinish(ReviewErrorWorkflowFinish))
      .returns(oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto))
      .switch(
        caseOf(CompanyGradeDto)
          .toAgent(JobOfferAgent)
          .returns(JobOfferDto)
          .toFinish(JobOfferWorkflowFinish),
        caseOf(CompanyRejectedDto)
          .toFinish(NoOfferRejectedWorkflowFinish),
        caseOf(CompanyReviewFailedDto)
          .toFinish(NoOfferFailedWorkflowFinish),
      ),
  ],
})
export class LinkOfferWorkflow {}

@Application({
  name: "company-review-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CompanyReviewWorkflow, CompanyScreeningWorkflow, JobOfferWorkflow, LinkOfferWorkflow],
  budgets: TEST_BUDGETS,
})
export class CompanyReviewApplication {}
