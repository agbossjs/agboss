import {
  onAction,
  onAgent,
  anyOf,
  group,
  route,
  onStart,
  toAction,
  toFinish,
} from "../../../src/flow/builder.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Arbiter, OnAnswer } from "../../../src/flow/decorators/arbiter.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { CompanyCheckDto } from "./launch-dtos.js";
import {
  AuditorAgent,
  BoardSearchAgent,
  CandidateReviewWorkflowStart,
  CompanySearchWorkflowStart,
  CompanyShortlistAgent,
  CompanyShortlistWorkflowFinish,
  CompanyVetAgent,
  CultureScoreAgent,
  DealCriticAgent,
  DealRoomOpenedWorkflowFinish,
  DealWorkflowStart,
  DueDiligenceReportWorkflowFinish,
  FastScreenAgent,
  FitReviewWorkflowStart,
  FitSummaryAgent,
  FitSummaryWorkflowFinish,
  FullReviewAgent,
  LegalAgent,
  NotifyReviewerAction,
  OpenDealRoomAction,
  QuickRejectWorkflowFinish,
  ReviewerNotifiedWorkflowFinish,
  SalaryFitAgent,
  ScoreAAgent,
  ScoreBAgent,
  ScoreCAgent,
  ScoreReviewFailedWorkflowFinish,
  ScoreReviewWorkflowFinish,
  ScoreSummaryAgent,
  SecondOpinionRouter,
  SkillsScoreAgent,
} from "./quorum-agents.js";
import { ScoreDto } from "./quorum-dtos.js";

/**
 * #279 — the issue's quorums, each a workflow: any two of three with a deadline and `anyOf(…)`
 * arbiters, different DTOs left out of a quorum (`optional`), a per-item launch with a chain of a
 * code and a model arbiter, and groups with priority continuing their own paths. They pass the
 * analyser; their runtime is #279 PR 2.
 */

@Arbiter({
  name: "quick-score-arbiter",
  decidedBy: DecidedBy.Code,
  deps: [ExecutionContext],
})
export class QuickScoreArbiter {
  constructor(private readonly executionContext: ExecutionContext) {}

  @OnAnswer(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return this.isScore(answer);
  }

  @OnAnswer(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return this.isScore(answer);
  }

  @OnAnswer(ScoreCAgent)
  fromScoreC(answer: ScoreDto): boolean {
    return this.isScore(answer) && this.executionContext.step.copyNumber !== 0;
  }

  private isScore(answer: ScoreDto): boolean {
    return answer.score >= 1 && answer.score <= 10;
  }
}

@Arbiter({
  name: "valid-score-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: ScoreAAgent, prompt: "Gives a 1–10 score for technical skills, with a reason" },
    { agent: ScoreBAgent, prompt: "Names at least two concrete risks" },
    { agent: ScoreCAgent, prompt: "Ends with a clear hire / no hire" },
  ],
})
export class ValidScoreArbiter {}

@Workflow({
  name: "candidate-review-workflow",
  version: "1.0.0",
  flow: [
    onStart(CandidateReviewWorkflowStart)
      .toParallelAgents(ScoreAAgent, ScoreBAgent, ScoreCAgent)
      .acceptedBy(anyOf(QuickScoreArbiter, ValidScoreArbiter))
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
      .onError(StepFailedError, toFinish(ScoreReviewFailedWorkflowFinish))
      .toAgent(ScoreSummaryAgent)
      .toFinish(ScoreReviewWorkflowFinish),
  ],
})
export class CandidateReviewWorkflow {}

@Workflow({
  name: "fit-review-workflow",
  version: "1.0.0",
  flow: [
    onStart(FitReviewWorkflowStart)
      .toParallelAgents(SkillsScoreAgent, CultureScoreAgent, SalaryFitAgent)
      .joinQuorum({ min: 2 })
      .toAgent(FitSummaryAgent)
      .toFinish(FitSummaryWorkflowFinish),
  ],
})
export class FitReviewWorkflow {}

@Arbiter({
  name: "good-score-arbiter",
  decidedBy: DecidedBy.Code,
})
export class GoodScoreArbiter {
  @OnAnswer(CompanyVetAgent)
  fromCompanyVet(answer: CompanyCheckDto): boolean {
    return answer.passed;
  }
}

@Arbiter({
  name: "convincing-reason-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: CompanyVetAgent, prompt: "The check names concrete facts about the company" },
  ],
})
export class ConvincingReasonArbiter {}

@Workflow({
  name: "company-search-workflow",
  version: "1.0.0",
  maxSteps: 60, // a launch of up to 50 items
  flow: [
    onStart(CompanySearchWorkflowStart)
      .toAgent(BoardSearchAgent)
      .toParallelAgents(CompanyVetAgent, { maxItems: 50 })
      .acceptedBy(GoodScoreArbiter)
      .acceptedBy(ConvincingReasonArbiter)
      .joinQuorum({ min: 5, deadline: minutes(2) })
      .toAgent(CompanyShortlistAgent)
      .toFinish(CompanyShortlistWorkflowFinish),
  ],
})
export class CompanySearchWorkflow {}

@Arbiter({
  name: "due-diligence-arbiter",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Count an answer only if it meets the criterion of the agent that gave it.",
  criteria: [
    { agent: LegalAgent, prompt: "Names the legal risks found, or states that none were found" },
    { agent: DealCriticAgent, prompt: "Gives at least one concrete objection" },
    { agent: AuditorAgent, prompt: "Ends with a clear pass / fail of the audit" },
    { agent: FastScreenAgent, prompt: "Any non-empty answer" },
  ],
})
export class DueDiligenceArbiter {}

@Workflow({
  name: "due-diligence-workflow",
  version: "1.0.0",
  flow: [
    onStart(DealWorkflowStart)
      .toParallelAgents(
        LegalAgent,
        DealCriticAgent,
        DealCriticAgent,
        AuditorAgent,
        FastScreenAgent,
        { maxConcurrency: 4 },
      )
      .acceptedBy(DueDiligenceArbiter)
      .joinQuorumGroups(
        group(LegalAgent, DealCriticAgent)
          .priority(1)
          .toAgent(FullReviewAgent),
        group(AuditorAgent)
          .priority(1)
          .toAction(OpenDealRoomAction)
          .toFinish(DealRoomOpenedWorkflowFinish),
        group(DealCriticAgent, DealCriticAgent)
          .priority(2)
          .toRouter(SecondOpinionRouter)
          .chooseOne(route(FullReviewAgent), route(NotifyReviewerAction)),
        group(FastScreenAgent)
          .priority(3)
          .toFinish(QuickRejectWorkflowFinish),
        { deadline: minutes(1) },
      )
      .onError(StepFailedError, toAction(NotifyReviewerAction)),

    onAgent(FullReviewAgent)
      .toFinish(DueDiligenceReportWorkflowFinish),

    onAction(NotifyReviewerAction)
      .toFinish(ReviewerNotifiedWorkflowFinish),
  ],
})
export class DueDiligenceWorkflow {}
