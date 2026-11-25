import {
  onAction,
  onAgent,
  onStart,
  toAction,
  toAgent,
  toFinish,
  toRouter,
} from "../../../src/flow/builder.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Arbiter, Arbitrate } from "../../../src/flow/decorators/arbiter.js";
import { inline } from "../../../src/components/prompt-source.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { StepFailedError } from "../../../src/graph/errors.js";
import { minutes, seconds, Ttl } from "../../../src/units/index.js";
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
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #279 — the issue's quorums, each a workflow: any two of three with a deadline and an arbiter
 * arbiters, different DTOs left out of a quorum (`optional`), a per-item launch with a chain of a
 * code and a model arbiter, and groups with priority continuing their own paths. They pass the
 * analyser; their runtime is #279 PR 2.
 */

@Arbiter({
  name: "quick-score-arbiter",
  deps: [ExecutionContext],
})
export class QuickScoreArbiter {
  constructor(private readonly executionContext: ExecutionContext) {}

  @Arbitrate(ScoreAAgent)
  fromScoreA(answer: ScoreDto): boolean {
    return this.isScore(answer);
  }

  @Arbitrate(ScoreBAgent)
  fromScoreB(answer: ScoreDto): boolean {
    return this.isScore(answer);
  }

  @Arbitrate(ScoreCAgent)
  fromScoreC(answer: ScoreDto): boolean {
    return this.isScore(answer) && this.executionContext.step.copyNumber !== 0;
  }

  private isScore(answer: ScoreDto): boolean {
    return answer.score >= 1 && answer.score <= 10;
  }
}

@Arbiter({
  name: "valid-score-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  prompt: inline("Count an answer only if it meets the criterion of the agent that gave it."),
  criteria: [
    { target: ScoreAAgent, prompt: "Gives a 1–10 score for technical skills, with a reason" },
    { target: ScoreBAgent, prompt: "Names at least two concrete risks" },
    { target: ScoreCAgent, prompt: "Ends with a clear hire / no hire" },
  ],
})
export class ValidScoreArbiter {}

@Workflow({
  name: "candidate-review-workflow",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(CandidateReviewWorkflowStart)
      .inParallel([toAgent(ScoreAAgent), toAgent(ScoreBAgent), toAgent(ScoreCAgent)])
      .arbitratedBy(ValidScoreArbiter)
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FitReviewWorkflowStart)
      .inParallel([toAgent(SkillsScoreAgent), toAgent(CultureScoreAgent), toAgent(SalaryFitAgent)])
      .joinQuorum({ min: 2 })
      .toAgent(FitSummaryAgent)
      .toFinish(FitSummaryWorkflowFinish),
  ],
})
export class FitReviewWorkflow {}

@Arbiter({
  name: "good-score-arbiter",
})
export class GoodScoreArbiter {
  @Arbitrate(CompanyVetAgent)
  fromCompanyVet(answer: CompanyCheckDto): boolean {
    return answer.passed;
  }
}

@Arbiter({
  name: "convincing-reason-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  prompt: inline("Count an answer only if it meets the criterion of the agent that gave it."),
  criteria: [
    { target: CompanyVetAgent, prompt: "The check names concrete facts about the company" },
  ],
})
export class ConvincingReasonArbiter {}

@Workflow({
  name: "company-search-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 60 }, // a launch of up to 50 items
  flow: [
    onStart(CompanySearchWorkflowStart)
      .toAgent(BoardSearchAgent)
      .forEachItem(toAgent(CompanyVetAgent), { takeFirst: 50 })
      .arbitratedBy(ConvincingReasonArbiter)
      .joinQuorum({ min: 5, deadline: minutes(2) })
      .toAgent(CompanyShortlistAgent)
      .toFinish(CompanyShortlistWorkflowFinish),
  ],
})
export class CompanySearchWorkflow {}

@Arbiter({
  name: "due-diligence-arbiter",
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  prompt: inline("Count an answer only if it meets the criterion of the agent that gave it."),
  criteria: [
    { target: LegalAgent, prompt: "Names the legal risks found, or states that none were found" },
    { target: DealCriticAgent, prompt: "Gives at least one concrete objection" },
    { target: AuditorAgent, prompt: "Ends with a clear pass / fail of the audit" },
    { target: FastScreenAgent, prompt: "Any non-empty answer" },
  ],
})
export class DueDiligenceArbiter {}

@Workflow({
  name: "due-diligence-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DealWorkflowStart)
      .inParallel(
        [
          toAgent(LegalAgent),
          toAgent(DealCriticAgent),
          toAgent(DealCriticAgent),
          toAgent(AuditorAgent),
          toAgent(FastScreenAgent),
        ],
        { maxConcurrency: 4 },
      )
      .arbitratedBy(DueDiligenceArbiter)
      .joinQuorumGroups({ deadline: minutes(1) })
      .onError(StepFailedError, toAction(NotifyReviewerAction))
      .onGroup([LegalAgent, DealCriticAgent], { priority: 1 }, toAgent(FullReviewAgent))
      .onGroup(
        [AuditorAgent],
        { priority: 1 },
        toAction(OpenDealRoomAction)
          .toFinish(DealRoomOpenedWorkflowFinish),
      )
      .onGroup(
        [DealCriticAgent, DealCriticAgent],
        { priority: 2 },
        toRouter(SecondOpinionRouter)
          .onRoute(toAgent(FullReviewAgent))
          .onRoute(toAction(NotifyReviewerAction)),
      )
      .onGroup([FastScreenAgent], { priority: 3 }, toFinish(QuickRejectWorkflowFinish)),

    onAgent(FullReviewAgent)
      .toFinish(DueDiligenceReportWorkflowFinish),

    onAction(NotifyReviewerAction)
      .toFinish(ReviewerNotifiedWorkflowFinish),
  ],
})
export class DueDiligenceWorkflow {}
