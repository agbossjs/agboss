import { TerminalUserChannel } from "../../../../src/channels/terminal-channel.js";
import { Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import {
  Agent,
  DecidedBy,
  Injectable,
  Router,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnValuesOutdated,
  type ToolHandler,
  type ValuesOutdatedEvent,
} from "../../../../src/index.js";
import { about, oneOf, optional } from "../../../../src/flow/dto-wrappers.js";
import { agent, caseOf, route, start } from "../../../helpers/flow.js";
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

/**
 * #271 PR 2 — workflows that outdate at run time: the review loop of the issue (`about(DraftDto, …)`
 * on the reviewer, which may pause on a tool) and a job search without a cycle, where a new profile
 * outdates the jobs found for the old one, their scores and the pick (three levels). Every cascade
 * is seen by `OutdatingLog`.
 */

/** Every `onValuesOutdated` event, in order (reset with `resetOutdatingLog`). */
export const outdatingEvents: ValuesOutdatedEvent[] = [];

export const resetOutdatingLog = (): void => {
  outdatingEvents.length = 0;
};

@Injectable()
export class OutdatingLog implements OnValuesOutdated {
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
  name: "ask_editor",
  description: "Asks the editor about the draft",
  channel: TerminalUserChannel,
  input: EditorQuestion,
  output: EditorQuestion,
})
export class AskEditorTool implements ToolHandler<EditorQuestion, EditorQuestion> {
  run(input: EditorQuestion): Promise<EditorQuestion> {
    return Promise.resolve(input);
  }
}

@WorkflowStart({ name: "loop-workflow-start", description: "The topic", input: ArticleRequestDto })
export class LoopWorkflowStart {}

@Agent({
  name: "loop-researcher-agent",
  description: "Researches the topic",
  prompt: "Research the topic.",
  model: "moonshotai/kimi-k2.6",
  input: { request: ArticleRequestDto },
  output: ResearchDto,
})
export class LoopResearcherAgent {}

@Agent({
  name: "loop-writer-agent",
  description: "Writes the draft, or rewrites it from the notes",
  prompt: "Write the draft.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 8,
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
  prompt: "Review the draft.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 8,
  tools: [AskEditorTool],
  input: { draft: DraftDto },
  output: about(DraftDto, oneOf(ApprovalDto, DraftChangesDto)),
})
export class LoopReviewerAgent {}

@Agent({
  name: "loop-publisher-agent",
  description: "Publishes the approved draft",
  prompt: "Publish the draft.",
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
  maxSteps: 30,
  observers: [OutdatingLog],
  channelClasses: [TerminalUserChannel],
  flow: [
    start(LoopWorkflowStart)
      .returns(ArticleRequestDto)
      .toAgent(LoopResearcherAgent)
      .returns(ResearchDto)
      .toAgent(LoopWriterAgent),
    agent(LoopWriterAgent)
      .returns(DraftDto)
      .toAgent(LoopReviewerAgent)
      .switch(
        caseOf(DraftChangesDto)
          .toAgent(LoopWriterAgent),
        caseOf(ApprovalDto)
          .toAgent(LoopPublisherAgent)
          .returns(ArticleDto)
          .toFinish(LoopWorkflowFinish),
      ),
  ],
})
export class LoopWorkflow {}

@Application({
  name: "loop-application",
  version: "1.0.0",
  workflows: [LoopWorkflow],
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
  prompt: "Build the profile.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { message: WorkflowStartTextDto },
  output: CandidateProfileDto,
})
export class ProfileAgent {}

@Agent({
  name: "search-agent",
  description: "Finds jobs for the profile",
  prompt: "Find jobs.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  input: { profile: CandidateProfileDto },
  output: JobListDto,
})
export class SearchAgent {}

@Agent({
  name: "score-agent",
  description: "Scores the jobs",
  prompt: "Score the jobs.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
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
  prompt: "Advise.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
  output: AdviceDto,
})
export class AdviceAgent {}

@Agent({
  name: "pick-agent",
  description: "Picks the job to apply for",
  prompt: "Pick a job.",
  model: "moonshotai/kimi-k2.6",
  maxVisits: 3,
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
  prompt: "Is the pick good?",
  model: "typesafe/jev-1.13",
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
  maxSteps: 20,
  observers: [OutdatingLog],
  flow: [
    start(JobsWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ProfileAgent),
    agent(ProfileAgent)
      .returns(CandidateProfileDto)
      .toAgent(SearchAgent)
      .returns(JobListDto)
      .toAgent(ScoreAgent)
      .returns(JobScoresDto)
      .toAgent(AdviceAgent)
      .returns(AdviceDto)
      .toAgent(PickAgent)
      .returns(JobPickDto)
      .toRouter(JobsRouter)
      .chooseOne(route(ProfileAgent), route(JobsWorkflowFinish)),
  ],
})
export class JobsWorkflow {}

@Application({
  name: "jobs-application",
  version: "1.0.0",
  workflows: [JobsWorkflow],
  budgets: TEST_BUDGETS,
})
export class JobsApplication {}
