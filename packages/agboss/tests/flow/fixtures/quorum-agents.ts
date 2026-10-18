import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { listOf, optional } from "../../../src/flow/dto-wrappers.js";
import type { InputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { CompanyDto } from "./data-dtos.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { CompanyCheckDto } from "./launch-dtos.js";
import {
  AuditDto,
  CandidateDto,
  CompanyShortlistDto,
  CultureScoreDto,
  DealCritiqueDto,
  DealDto,
  DueDiligenceReportDto,
  FastScreenDto,
  FitSummaryDto,
  LegalReviewDto,
  SalaryFitDto,
  ScoreDto,
  ScoreReviewDto,
  SkillsScoreDto,
} from "./quorum-dtos.js";

/** #279 — the components of the issue's quorums (`quorum.fixture.ts` wires them). */

const MODEL = "moonshotai/kimi-k2.6";

// ── any two of three ──

@WorkflowStart({ name: "candidate-review-workflow-start", description: "A candidate", input: CandidateDto })
export class CandidateReviewWorkflowStart {}

@Agent({ name: "score-a-agent", description: "Scores the skills", prompt: "Score the skills.", model: MODEL, input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreAAgent {}

@Agent({ name: "score-b-agent", description: "Scores the risks", prompt: "Score the risks.", model: MODEL, input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreBAgent {}

@Agent({ name: "score-c-agent", description: "Scores the hire", prompt: "Score the hire.", model: MODEL, input: { candidate: CandidateDto }, output: ScoreDto })
export class ScoreCAgent {}

@Agent({
  name: "score-summary-agent",
  description: "Sums up the counted scores",
  prompt: "Sum up the scores.",
  model: MODEL,
  input: { candidate: CandidateDto, scores: listOf(ScoreDto) },
  output: ScoreReviewDto,
})
export class ScoreSummaryAgent {}

@WorkflowFinish({ name: "score-review-workflow-finish", description: "The review", output: ScoreReviewDto })
export class ScoreReviewWorkflowFinish {}

@WorkflowFinish({ name: "score-review-failed-workflow-finish", description: "No quorum", output: CandidateDto })
export class ScoreReviewFailedWorkflowFinish {}

// ── different DTOs: optional after the quorum ──

@WorkflowStart({ name: "fit-review-workflow-start", description: "A candidate", input: CandidateDto })
export class FitReviewWorkflowStart {}

@Agent({ name: "skills-score-agent", description: "Scores skills", prompt: "Score.", model: MODEL, input: { candidate: CandidateDto }, output: SkillsScoreDto })
export class SkillsScoreAgent {}

@Agent({ name: "culture-score-agent", description: "Scores culture", prompt: "Score.", model: MODEL, input: { candidate: CandidateDto }, output: CultureScoreDto })
export class CultureScoreAgent {}

@Agent({ name: "salary-fit-agent", description: "Checks the salary", prompt: "Check.", model: MODEL, input: { candidate: CandidateDto }, output: SalaryFitDto })
export class SalaryFitAgent {}

@Agent({
  name: "fit-summary-agent",
  description: "Sums up the fit",
  prompt: "Sum up the fit.",
  model: MODEL,
  input: {
    skills: optional(SkillsScoreDto),
    culture: optional(CultureScoreDto),
    salary: optional(SalaryFitDto),
  },
  output: FitSummaryDto,
})
export class FitSummaryAgent {}

@WorkflowFinish({ name: "fit-summary-workflow-finish", description: "The fit", output: FitSummaryDto })
export class FitSummaryWorkflowFinish {}

// ── per item, a chain of arbiters ──

@WorkflowStart({ name: "company-search-workflow-start", description: "What to look for", input: WorkflowStartTextDto })
export class CompanySearchWorkflowStart {}

@Agent({ name: "board-search-agent", description: "Finds companies", prompt: "Find.", model: MODEL, input: { message: WorkflowStartTextDto }, output: listOf(CompanyDto) })
export class BoardSearchAgent {}

@Agent({ name: "company-vet-agent", description: "Checks one company", prompt: "Check.", model: MODEL, input: { company: CompanyDto }, output: CompanyCheckDto })
export class CompanyVetAgent {}

@Agent({
  name: "company-shortlist-agent",
  description: "Shortlists the counted companies",
  prompt: "Shortlist.",
  model: MODEL,
  input: { checks: listOf(CompanyCheckDto) },
  output: CompanyShortlistDto,
})
export class CompanyShortlistAgent {}

@WorkflowFinish({ name: "company-shortlist-workflow-finish", description: "The shortlist", output: CompanyShortlistDto })
export class CompanyShortlistWorkflowFinish {}

// ── groups with priority ──

@WorkflowStart({ name: "deal-workflow-start", description: "A deal", input: DealDto })
export class DealWorkflowStart {}

@Agent({ name: "legal-agent", description: "Legal review", prompt: "Review.", model: MODEL, input: { deal: DealDto }, output: LegalReviewDto })
export class LegalAgent {}

@Agent({ name: "deal-critic-agent", description: "Objects", prompt: "Object.", model: MODEL, input: { deal: DealDto }, output: DealCritiqueDto })
export class DealCriticAgent {}

@Agent({ name: "auditor-agent", description: "Audits", prompt: "Audit.", model: MODEL, input: { deal: DealDto }, output: AuditDto })
export class AuditorAgent {}

@Agent({ name: "fast-screen-agent", description: "Screens", prompt: "Screen.", model: MODEL, input: { deal: DealDto }, output: FastScreenDto })
export class FastScreenAgent {}

@Agent({
  name: "full-review-agent",
  description: "Writes the due diligence report from the counted reviews",
  prompt: "Write the report.",
  model: MODEL,
  input: { deal: DealDto, legal: optional(LegalReviewDto), critiques: listOf(DealCritiqueDto) },
  output: DueDiligenceReportDto,
})
export class FullReviewAgent {}

@Action({ name: "open-deal-room-action", description: "Opens the deal room", input: { audit: AuditDto } })
export class OpenDealRoomAction implements ActionHandler<OpenDealRoomAction> {
  async execute(input: InputOf<OpenDealRoomAction>): Promise<void> {
    await Promise.resolve(input.audit.value.passed);
  }
}

@Action({ name: "notify-reviewer-action", description: "Tells a reviewer", input: { deal: DealDto } })
export class NotifyReviewerAction implements ActionHandler<NotifyReviewerAction> {
  async execute(input: InputOf<NotifyReviewerAction>): Promise<void> {
    await Promise.resolve(input.deal.value.name);
  }
}

@Router({
  name: "second-opinion-router",
  description: "Decides what two critiques lead to",
  decidedBy: DecidedBy.Model,
  prompt: "Pick what the critiques lead to.",
  model: "typesafe/jev-1.13",
  input: { critiques: listOf(DealCritiqueDto) },
  routes: [
    { prompt: "A full review is worth it", target: FullReviewAgent },
    { prompt: "Stop and tell a reviewer", target: NotifyReviewerAction },
  ],
})
export class SecondOpinionRouter {}

@WorkflowFinish({ name: "due-diligence-report-workflow-finish", description: "The report", output: DueDiligenceReportDto })
export class DueDiligenceReportWorkflowFinish {}

@WorkflowFinish({ name: "deal-room-opened-workflow-finish", description: "The audit", output: AuditDto })
export class DealRoomOpenedWorkflowFinish {}

@WorkflowFinish({ name: "quick-reject-workflow-finish", description: "Rejected at once", output: FastScreenDto })
export class QuickRejectWorkflowFinish {}

@WorkflowFinish({ name: "reviewer-notified-workflow-finish", description: "Left to a reviewer", output: DealDto })
export class ReviewerNotifiedWorkflowFinish {}
