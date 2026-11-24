import { Workflow, onStart } from "@agboss/core";
import { DeskHttpAuthenticator } from "../../a2a/desk.http-authenticator.js";
import { DeskAgent } from "../../agents/desk/desk.agent.js";
import { CaseNotesMemory } from "../../memories/case-notes/case-notes.memory.js";
import { CustomerIdPiiPolicy } from "../../pii-policies/customer-id.pii-policy.js";
import { CaseNotesService } from "../../services/case-notes.service.js";
import { OrderDeskService } from "../../services/order-desk.service.js";
import { ShippingPolicyRag } from "../../rag/shipping-policy.rag.js";
import { DeskAnswerWorkflowFinish } from "./desk-answer.workflow-finish.js";
import { DeskWorkflowStart } from "./desk.workflow-start.js";

/**
 * The help desk (#382–#385): one agent on a transport model provider, its code guardrails and tool
 * interceptor, a memory with its own compaction once a thread holds more than two turns, and its own PII policy;
 * served over A2A by `desk-application` (its caller resolver is a provider like any service).
 */
@Workflow({
  name: "desk-workflow",
  version: "1.0.0",
  flow: [
    onStart(DeskWorkflowStart)
      .toAgent(DeskAgent)
      .toFinish(DeskAnswerWorkflowFinish),
  ],
  memory: CaseNotesMemory,
  piiPolicies: [CustomerIdPiiPolicy],
  providers: [OrderDeskService, CaseNotesService, ShippingPolicyRag, DeskHttpAuthenticator], // the last: A2A callers
})
export class DeskWorkflow {}
