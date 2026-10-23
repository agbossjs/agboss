import {
  EvalCascade,
  EvalSuite,
  checkTrajectory,
  evalCase,
  turn,
} from "../../../../src/eval/index.js";
import { AskWorkflowStart } from "../evals.fixture.js";

/** Two cases of one name: `[eval.duplicate-case]` in `agboss check`. */
@EvalSuite({
  name: "broken-eval-suite",
  description: "Two cases share a name",
  start: AskWorkflowStart,
  checks: [checkTrajectory()],
  cascade: EvalCascade.RunAll,
  cases: [
    evalCase({ name: "twice", turns: [turn({ text: "a" })] }),
    evalCase({ name: "twice", turns: [turn({ text: "b" })] }),
  ],
})
export class BrokenEvalSuite {}
