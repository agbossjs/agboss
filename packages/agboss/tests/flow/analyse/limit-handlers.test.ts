import { describe, expect, it } from "vitest";
import type { ErrorClass } from "../../../src/flow/ast.js";
import type { PathBuilder } from "../../../src/flow/path-builder.js";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { catchesLimit } from "../../../src/flow/analyse/rules/limit-handlers.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf, oneOf } from "../../../src/flow/dto-wrappers.js";
import { AGBossError } from "../../../src/core/errors.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { BudgetExceededError, LimitExceededError } from "../../../src/graph/limits.js";
import { VisitsLimitExceededError } from "../../../src/flow/runtime/errors.js";
import {
  CompanyGradeDto,
  CompanyRejectedDto,
  CompanyReviewFailedDto,
  GradedShortlistDto,
  JobOfferDto,
} from "../fixtures/child-dtos.js";
import {
  CompanyFinderAgent,
  CompanyPickerAgent,
  CompanyReviewWorkflow,
  GradedShortlistWorkflowFinish,
  JobOfferAgent,
  JobOfferWorkflowFinish,
  JobOfferWorkflowStart,
  NoOfferFailedWorkflowFinish,
  NoOfferRejectedWorkflowFinish,
  ReviewErrorWorkflowFinish,
  ReviewRankerAgent,
} from "../fixtures/children.fixture.js";
import { CompanyDto } from "../fixtures/data-dtos.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import { caseOf, start, toAction, toAgent, toFinish } from "../fixtures/paths.js";

/**
 * #263 AC12: a side path that can catch a limit leads only to actions and finishes —
 * `[graph.limit-handler-uses-model]` when it reaches an agent, a router or a child workflow.
 */

type Flow = WorkflowOptions["flow"];

let count = 0;
function workflowWith(flow: Flow): abstract new () => unknown {
  count += 1;
  @Workflow({ name: `limit-case-${String(count)}-workflow`, version: "1.0.0", flow })
  class LimitCaseWorkflow {}
  return LimitCaseWorkflow;
}

const errorsOf = (flow: Flow) =>
  checkWorkflow(workflowWith(flow)).errors.map(({ code, message }) => ({
    code,
    message: message.replace(/^limit-case-\d+-workflow: /, ""),
  }));

@Agent({
  name: "apology-agent",
  description: "Writes an apology instead of the offer",
  prompt: "Apologise.",
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
  output: JobOfferDto,
})
class ApologyAgent {}

@Action({
  name: "log-failure-action",
  description: "Logs the failure",
  input: { message: WorkflowStartTextDto },
})
class LogFailureAction {
  async execute(): Promise<void> {
    await Promise.resolve();
  }
}

const REVIEWED = oneOf(CompanyGradeDto, CompanyRejectedDto, CompanyReviewFailedDto);

/** `.toWorkflow(CompanyReviewWorkflow)` caught by `error` on the side path `side`. */
const reviewed = (error: ErrorClass, side: PathBuilder) =>
  start(JobOfferWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toAgent(CompanyPickerAgent)
    .returns(CompanyDto)
    .toWorkflow(CompanyReviewWorkflow)
    .onError(error, side)
    .returns(REVIEWED)
    .switch(
      caseOf(CompanyGradeDto)
        .toAgent(JobOfferAgent)
        .returns(JobOfferDto)
        .toFinish(JobOfferWorkflowFinish),
      caseOf(CompanyRejectedDto).toFinish(NoOfferRejectedWorkflowFinish),
      caseOf(CompanyReviewFailedDto).toFinish(NoOfferFailedWorkflowFinish),
    );

const apology = () => toAgent(ApologyAgent).returns(JobOfferDto).toFinish(JobOfferWorkflowFinish);

describe("#263 AC12: limit handler uses model", () => {
  it("which classes can catch a limit: the class, its subclasses and its parents", () => {
    expect(
      [
        LimitExceededError,
        BudgetExceededError,
        VisitsLimitExceededError,
        AGBossError,
        Error,
        StepFailedError,
      ].map(catchesLimit),
    ).toEqual([true, true, true, true, true, false]);
  });

  it("a side path catching a limit that reaches an agent", () => {
    expect(errorsOf([reviewed(LimitExceededError, apology())])).toEqual([
      {
        code: "graph.limit-handler-uses-model",
        message:
          "company-review-workflow: .onError(LimitExceededError, …) can catch a limit and reaches apology-agent — after a limit a side path leads only to actions and finishes (no model call past a limit); catch a narrower class, or end the side path with toAction(…) / toFinish(…)",
      },
    ]);
  });

  it("a parent of the limits (AGBossError) counts; reaching the agent through an action too", () => {
    const viaAction = toAction(LogFailureAction)
      .toAgent(ApologyAgent)
      .returns(JobOfferDto)
      .toFinish(JobOfferWorkflowFinish);
    expect(errorsOf([reviewed(AGBossError, viaAction)]).map((found) => found.code)).toEqual([
      "graph.limit-handler-uses-model",
    ]);
  });

  it("a step failure may lead to an agent; a limit to an action and a finish", () => {
    expect(errorsOf([reviewed(StepFailedError, apology())])).toEqual([]);
    const notify = toAction(LogFailureAction).toFinish(ReviewErrorWorkflowFinish);
    expect(errorsOf([reviewed(LimitExceededError, notify)])).toEqual([]);
    expect(errorsOf([reviewed(BudgetExceededError, toFinish(ReviewErrorWorkflowFinish))])).toEqual(
      [],
    );
  });

  it("the join's .onJoinError(LimitExceededError, …) leading to an agent", () => {
    const joined = start(JobOfferWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(CompanyFinderAgent)
      .returns(listOf(CompanyDto))
      .toParallelWorkflows(CompanyReviewWorkflow, { maxItems: 5 })
      .join()
      .onJoinError(LimitExceededError, apology())
      .returns(listOf(REVIEWED))
      .toAgent(ReviewRankerAgent)
      .returns(GradedShortlistDto)
      .toFinish(GradedShortlistWorkflowFinish);
    expect(errorsOf([joined])).toEqual([
      {
        code: "graph.limit-handler-uses-model",
        message:
          "the join of company-finder-agent → toParallelWorkflows(company-review-workflow): .onJoinError(LimitExceededError, …) can catch a limit and reaches apology-agent — after a limit a side path leads only to actions and finishes (no model call past a limit); catch a narrower class, or end the side path with toAction(…) / toFinish(…)",
      },
    ]);
  });
});
