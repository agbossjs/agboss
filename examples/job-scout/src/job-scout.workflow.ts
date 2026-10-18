import {
  Workflow,
  provide,
  route,
  start,
  WorkflowSettings,
  type WorkflowDefinition,
  TerminalUserChannel,
} from "agboss";
import { WorkflowStartTextDto } from "agboss/dto";
import { usd } from "agboss/units";
import { Reasoning } from "agboss/models";
import { GUARDS, KIMI } from "./config/settings.js";
import { ProfilerAgent } from "./agents/profiler.agent.js";
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
  defaults: { history: { limit: 8 } }, // the rest from the application's DEFAULTS (#261 cascade)
  guards: GUARDS,
  compaction: { every: 5, keep: 10, model: { model: KIMI, reasoning: Reasoning.off() } },
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
  channelClasses: [TerminalUserChannel],
})
export class JobScout implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.1) }, perDay: { cost: usd(1) } })
      .build();
  }
}
