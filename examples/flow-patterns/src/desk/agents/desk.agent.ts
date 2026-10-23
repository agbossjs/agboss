import { Agent } from "agboss";
import { DeskQuestionDto } from "../dtos/desk-question.dto.js";
import { NoCredentialsGuardrail } from "../guardrails/no-credentials.guardrail.js";
import { NoPromisesGuardrail } from "../guardrails/no-promises.guardrail.js";
import { DeskAuditToolInterceptor } from "../tool-interceptors/desk-audit.tool-interceptor.js";
import { CloseAccountTool } from "../tools/close-account.tool.js";
import { OrderStatusTool } from "../tools/order-status.tool.js";

/**
 * Answers a customer about an order — a text agent on the offline `harness/desk` model: its two
 * code guardrails, its tool interceptor, and the workflow's custom compaction for older turns.
 */
@Agent({
  name: "desk-agent",
  description: "Answers questions about orders",
  promptUrls: ["./desk.prompt.md"],
  model: "harness/desk",
  input: { question: DeskQuestionDto },
  tools: [OrderStatusTool, CloseAccountTool],
  guardrails: [NoCredentialsGuardrail, NoPromisesGuardrail],
  toolInterceptors: [DeskAuditToolInterceptor],
  maxToolCalls: 3,
})
export class DeskAgent {}
