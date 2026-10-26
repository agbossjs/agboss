import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  judgedBy,
  toolCall,
  toolInvariant,
  turn,
} from "@agboss/core/eval";
import { DeskAnswerJudge } from "../judges/desk-answer.judge.js";
import { CloseAccountTool } from "../tools/close-account.tool.js";
import { OrderStatusTool } from "../tools/order-status.tool.js";
import { DeskWorkflowStart } from "../workflow-starts/desk.workflow-start.js";

/**
 * The desk's eval suite (#396): run offline by `desk-application`, whose transport model answers
 * by the request — `npx agboss eval run --application src/desk.application.ts --env test` needs no
 * key and spends no money. The free checks first, then the code judge.
 */
@EvalSuite({
  name: "desk-eval-suite",
  description: "The desk looks the order up and says where it is",
  start: DeskWorkflowStart,
  checks: [checkTrajectory(), judgedBy(DeskAnswerJudge)],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "order-looked-up",
      tenant: { tenantId: "eval-desk" },
      turns: [turn({ customerId: "c-1", question: "Where is order #7?" })],
      tools: {
        required: [toolCall(OrderStatusTool, { orderId: "7" })],
        forbidden: [CloseAccountTool],
      },
    }),
    evalCase({
      name: "archived-order",
      tenant: { tenantId: "eval-desk" },
      turns: [turn({ customerId: "c-2", question: "Where is order #A-12?" })],
      tools: {
        forbidden: [CloseAccountTool],
        invariants: [toolInvariant(OrderStatusTool, (input) => input.orderId === "A-12")],
      },
    }),
  ],
})
export class DeskEvalSuite {}
