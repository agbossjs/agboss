import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  turn,
} from "../../../../../src/eval/index.js";
import { DeskWorkflowStart } from "../../../../flow/fixtures/eval-desk.fixture.js";

/**
 * #396 PR 8 — the refunds desk's suite beside `sqlite-history-application`: `agboss generate
 * eval-case --from-execution` adds the cases drafted from its kept executions here.
 */
@EvalSuite({
  name: "refunds-eval-suite",
  description: "Refunds are looked up and made",
  start: DeskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.StopAtFirstFailure,
  cases: [
    evalCase({
      name: "refund-order-7",
      tenant: { tenantId: "acme", plan: "pro" },
      execution: { userId: "u-1" },
      turns: [turn({ text: "Refund order 7" })],
    }),
  ],
})
export class RefundsEvalSuite {}
