/**
 * `agboss/eval` (#396): eval suites — `@EvalSuite` in `eval-suites/<name>.eval-suite.ts` and the
 * builders of its cases and checks. Decorators and builders only: nothing runs at import; the
 * runner (`agboss eval run --suite <name>`) belongs to the CLI and loads on demand.
 */
export {
  EvalSuite,
  type EvalSuiteMeta,
  type EvalSuiteOptions,
} from "./suite/eval-suite.decorator.js";
export {
  evalCase,
  pastTurn,
  turn,
  type EvalCase,
  type EvalCaseOf,
  type EvalPastTurn,
  type EvalTurn,
  type EvalValueOf,
} from "./suite/cases.js";
export {
  CheckStatus,
  checkTrajectory,
  EvalCascade,
  judgedBy,
  type EvalCheck,
  type JudgeEvalCheck,
  type TrajectoryEvalCheck,
} from "./suite/checks.js";
export {
  toolCall,
  toolInvariant,
  type EvalToolExpectations,
  type ExpectedToolCall,
  type ToolArgumentsOf,
  type ToolInvariant,
} from "./suite/tool-expectations.js";
