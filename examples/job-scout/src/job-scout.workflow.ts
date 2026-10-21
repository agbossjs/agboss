import { Workflow, provide, route, start } from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { ConversationCompaction } from "./compactions/conversation.compaction.js";
import { ProfilerAgent } from "./agents/profiler.agent.js";
import { PersonalDataGuardrail } from "./guardrails/personal-data.guardrail.js";
import { PromptInjectionGuardrail } from "./guardrails/prompt-injection.guardrail.js";
import { ScoutAgent } from "./agents/scout.agent.js";
import { ShortlistAgent } from "./agents/shortlist.agent.js";
import { ChatWorkflowStart } from "./workflow-starts/chat.workflow-start.js";
import { ChatWorkflowFinish } from "./workflow-finishes/chat.workflow-finish.js";
import { MainRouter } from "./routers/main.router.js";
import { ShortlistServer } from "./mcp/shortlist.server.js";
import { NOTES_DB, NOTES_DIR, SHORTLIST, SHORTLIST_FILE } from "./config/paths.js";
import { NOTES_INDEX } from "./rag/company-notes.rag.js";
import { JobFitJudge } from "./services/job-fit.service.js";
import { ResumeReader } from "./services/resume-reader.service.js";
import { GreenhouseBoards } from "./services/greenhouse-boards.service.js";
import { jobScoutPromptVariables } from "./config/prompt-variables.js";
import { JOB_SEARCH, jobSearchConfig } from "./config/search.config.js";

/**
 * Resume from disk → proposed brief → Greenhouse jobs ranked by Jev, explained with the user's company
 * notes, the chosen ones saved to a shortlist (a write the user approves). One path per turn: the
 * message goes to the main router, which sends it to the agent that answers; the thread carries the
 * conversation from turn to turn.
 */
@Workflow({
  name: "job-scout-workflow",
  version: "3.0.0",
  flow: [
    start(ChatWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter)
      .chooseOne(
        route(ProfilerAgent)
          .toFinish(ChatWorkflowFinish),
        route(ScoutAgent)
          .toFinish(ChatWorkflowFinish),
        route(ShortlistAgent)
          .toFinish(ChatWorkflowFinish),
      ),
  ],
  guardrails: [PromptInjectionGuardrail, PersonalDataGuardrail], // every agent's; the router: input only
  uncompactedTurns: 8, // over the application's 5: its agents and router see the last 8 turns in full
  compaction: ConversationCompaction, // older turns: summaries of 5, the latest 10 kept
  mcp: [ShortlistServer],
  providers: [
    JobFitJudge,
    ResumeReader,
    GreenhouseBoards,
    provide(JOB_SEARCH, jobSearchConfig),
    provide(SHORTLIST, SHORTLIST_FILE),
    provide(NOTES_INDEX, { folder: NOTES_DIR, dbFile: NOTES_DB }),
  ],
  promptVariables: jobScoutPromptVariables(jobSearchConfig),
})
export class JobScout {}
