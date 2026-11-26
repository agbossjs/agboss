import { Window5Memory } from "../../../helpers/window-memory.js";
import { OwnerToolApproval } from "../../fixtures/owner-approval.fixture.js";
import { Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  Observer,
  Router,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ValuesOutdatedEvent,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { oneOf, optional } from "../../../../src/flow/dto-wrappers.js";
import { onAgent, onStart, toAgent, toFinish } from "../../../helpers/flow.js";
import { DraftChangesDto } from "../../fixtures/data-dtos.js";
import { ArticleDto, ArticleRequestDto } from "../../fixtures/dtos.js";
import {
  ApprovalDto,
  CandidateProfileDto,
  DraftDto,
  JobListDto,
  JobPickDto,
  JobScoresDto,
  ResearchDto,
} from "../../fixtures/review-dtos.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";
import { TestDecisionsModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #271 PR 2 — workflows that outdate at run time: the review loop of the issue (the reviewer's
 * answers `{ about: DraftDto }` in the flow, #299; it may pause on a tool) and a job search without a cycle, where a new profile
 * outdates the jobs found for the old one, their scores and the pick (three levels). Every cascade
 * is seen by `OutdatingLog`.
 */

/** Every `onValuesOutdated` event, in order (reset with `resetOutdatingLog`). */
export const outdatingEvents: ValuesOutdatedEvent[] = [];

export const resetOutdatingLog = (): void => {
  outdatingEvents.length = 0;
};

@Observer()
export class OutdatingLog {
  onValuesOutdated(event: ValuesOutdatedEvent): void {
    outdatingEvents.push(event);
  }
}

export class EditorQuestion {
  @Text({ prompt: "what to ask the editor" })
  text!: string;
}

/** The reviewer may ask the editor first: the execution pauses for an approval. */
@Tool({
  name: "ask-editor-tool",
  description: "Asks the editor about the draft",
  approval: OwnerToolApproval,
  input: EditorQuestion,
  output: EditorQuestion,
})
export class AskEditorTool {
  execute(input: EditorQuestion): Promise<EditorQuestion> {
    return Promise.resolve(input);
  }
}

@WorkflowStart({ name: "loop-workflow-start", description: "The topic", input: ArticleRequestDto })
export class LoopWorkflowStart {}

@Agent({
  name: "loop-researcher-agent",
  description: "Researches the topic",
  prompt: inline("Research the topic."),
  model: "moonshotai/kimi-k2.6",
  input: { request: ArticleRequestDto },
  output: ResearchDto,
})
export class LoopResearcherAgent {}

@Agent({
  name: "loop-writer-agent",
  description: "Writes the draft, or rewrites it from the notes",
  prompt: inline("Write the draft."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 8 },
  input: {
    request: ArticleRequestDto,
    research: ResearchDto,
    changes: optional(DraftChangesDto),
  },
  output: DraftDto,
})
export class LoopWriterAgent {}

@Agent({
  name: "loop-reviewer-agent",
  description: "Approves the draft or asks for changes",
  prompt: inline("Review the draft."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 8 },
  tools: [AskEditorTool],
  input: { draft: DraftDto },
  output: oneOf(ApprovalDto, DraftChangesDto),
})
export class LoopReviewerAgent {}

@Agent({
  name: "loop-publisher-agent",
  description: "Publishes the approved draft",
  prompt: inline("Publish the draft."),
  model: "moonshotai/kimi-k2.6",
  input: { draft: DraftDto, approval: ApprovalDto },
  output: ArticleDto,
})
export class LoopPublisherAgent {}

@WorkflowFinish({ name: "loop-workflow-finish", description: "The article", output: ArticleDto })
export class LoopWorkflowFinish {}

/** The review loop: research → write ⇄ review → publish. */
@Workflow({
  name: "loop-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  memory: Window5Memory,
  executionLimits: { maxSteps: 30 },
  flow: [
    onStart(LoopWorkflowStart).toAgent(LoopResearcherAgent).toAgent(LoopWriterAgent),
    onAgent(LoopWriterAgent)
      .toAgent(LoopReviewerAgent)
      .toOneOf([
        toAgent(LoopWriterAgent),
        toAgent(LoopPublisherAgent).toFinish(LoopWorkflowFinish),
      ]),
  ],
})
export class LoopWorkflow {}

@Application({
  name: "loop-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [LoopWorkflow],
  observers: [OutdatingLog],
  budgets: TEST_BUDGETS,
})
export class LoopApplication {}

@WorkflowStart({
  name: "jobs-workflow-start",
  description: "The candidate's message",
  input: WorkflowStartTextDto,
})
export class JobsWorkflowStart {}

@Agent({
  name: "profile-agent",
  description: "Builds the candidate's profile",
  prompt: inline("Build the profile."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 3 },
  input: { message: WorkflowStartTextDto },
  output: CandidateProfileDto,
})
export class ProfileAgent {}

@Agent({
  name: "search-agent",
  description: "Finds jobs for the profile",
  prompt: inline("Find jobs."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 3 },
  input: { profile: CandidateProfileDto },
  output: JobListDto,
})
export class SearchAgent {}

@Agent({
  name: "score-agent",
  description: "Scores the jobs",
  prompt: inline("Score the jobs."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 3 },
  input: { jobs: JobListDto },
  output: JobScoresDto,
})
export class ScoreAgent {}

export class AdviceDto {
  @Text({ prompt: "what to look for in the jobs" })
  advice!: string;
}

/** No `input`: it reads the thread, so its advice is built from every current value (rule 8). */
@Agent({
  name: "advice-agent",
  description: "Advises on the jobs",
  prompt: inline("Advise."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 3 },
  output: AdviceDto,
})
export class AdviceAgent {}

@Agent({
  name: "pick-agent",
  description: "Picks the job to apply for",
  prompt: inline("Pick a job."),
  model: "moonshotai/kimi-k2.6",
  executionLimits: { maxVisits: 3 },
  input: { scores: JobScoresDto, advice: AdviceDto },
  output: JobPickDto,
})
export class PickAgent {}

@WorkflowFinish({ name: "jobs-workflow-finish", description: "The pick", output: JobPickDto })
export class JobsWorkflowFinish {}

@Router({
  name: "jobs-router",
  description: "Starts over with a new profile, or stops",
  decidedBy: DecidedBy.Model,
  prompt: inline("Is the pick good?"),
  model: "typesafe/jev-1.13",
  modelProvider: TestDecisionsModelProvider,
  maxVisits: 3,
  input: { pick: JobPickDto },
  routes: [
    { prompt: "The profile needs to change", target: ProfileAgent },
    { prompt: "Stop and send the pick: it is good", target: JobsWorkflowFinish },
  ],
})
export class JobsRouter {}

/** profile → search → score → advice → pick → router: back to the profile, or the pick. */
@Workflow({
  name: "jobs-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  memory: Window5Memory,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(JobsWorkflowStart).toAgent(ProfileAgent),
    onAgent(ProfileAgent)
      .toAgent(SearchAgent)
      .toAgent(ScoreAgent)
      .toAgent(AdviceAgent)
      .toAgent(PickAgent)
      .toRouter(JobsRouter)
      .onRoute(toAgent(ProfileAgent))
      .onRoute(toFinish(JobsWorkflowFinish)),
  ],
})
export class JobsWorkflow {}

@Application({
  name: "jobs-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [JobsWorkflow],
  observers: [OutdatingLog],
  budgets: TEST_BUDGETS,
})
export class JobsApplication {}
