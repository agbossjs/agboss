import { Workflow, start } from "agboss";
import { DeskAgent } from "./agents/desk.agent.js";
import { CaseNotesCompaction } from "./compactions/case-notes.compaction.js";
import { DeskQuestionDto } from "./dtos/desk-question.dto.js";
import { CaseNotesService } from "./services/case-notes.service.js";
import { OrderDeskService } from "./services/order-desk.service.js";
import { DeskAnswerWorkflowFinish } from "./workflow-finishes/desk-answer.workflow-finish.js";
import { DeskWorkflowStart } from "./workflow-starts/desk.workflow-start.js";

/**
 * The help desk (#382–#385): one agent on a transport model provider, its code guardrails and tool
 * interceptor, and a custom compaction once a thread holds more than two turns.
 */
@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    start(DeskWorkflowStart)
      .returns(DeskQuestionDto)
      .toAgent(DeskAgent)
      .toFinish(DeskAnswerWorkflowFinish),
  ],
  uncompactedTurns: 2,
  compaction: CaseNotesCompaction,
  providers: [OrderDeskService, CaseNotesService],
})
export class DeskWorkflow {}
