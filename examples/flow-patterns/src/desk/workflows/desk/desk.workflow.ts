import { Workflow, start } from "@agboss/core";
import { DeskA2aCallerResolver } from "../../a2a/desk.a2a-caller-resolver.js";
import { DeskAgent } from "../../agents/desk/desk.agent.js";
import { CaseNotesCompaction } from "../../compactions/case-notes/case-notes.compaction.js";
import { DeskQuestionDto } from "../../dto/desk-question.dto.js";
import { CustomerIdPiiPolicy } from "../../pii-policies/customer-id.pii-policy.js";
import { CaseNotesService } from "../../services/case-notes.service.js";
import { OrderDeskService } from "../../services/order-desk.service.js";
import { DeskAnswerWorkflowFinish } from "./desk-answer.workflow-finish.js";
import { DeskWorkflowStart } from "./desk.workflow-start.js";

/**
 * The help desk (#382–#385): one agent on a transport model provider, its code guardrails and tool
 * interceptor, a custom compaction once a thread holds more than two turns, and its own PII policy;
 * served over A2A by `desk-application` (its caller resolver is a provider like any service).
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
  piiPolicies: [CustomerIdPiiPolicy],
  providers: [OrderDeskService, CaseNotesService, DeskA2aCallerResolver], // the last: A2A callers
})
export class DeskWorkflow {}
