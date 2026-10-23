import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  judgedBy,
  toolCall,
  turn,
} from "../../../../src/eval/index.js";
import { AskWorkflowStart, LookupTool, QuotesLookupJudge } from "../evals.fixture.js";

@EvalSuite({
  name: "desk-eval-suite",
  description: "Orders are looked up and quoted",
  start: AskWorkflowStart,
  checks: [checkTrajectory(), judgedBy(QuotesLookupJudge)],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "looks-order-7-up",
      turns: [turn({ text: "Where is order 7?" })],
      tools: { required: [toolCall(LookupTool, { orderId: "7" })] },
    }),
    evalCase({
      name: "looks-order-8-up",
      turns: [turn({ text: "Where is order 8?" })],
      tools: { required: [toolCall(LookupTool, { orderId: "8" })] },
    }),
  ],
})
export class DeskEvalSuite {}
