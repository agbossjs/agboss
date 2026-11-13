/**
 * The types the scripted turns and the matchers of `@agboss/core/testing` compute with (#895,
 * @beta: type machinery, not a contract). `when(…)`, `.answer(…)` and `.called(…)` name them in a
 * type error; no test of yours writes them, so their names may change in any release. Types only:
 * re-exported as the namespace `TestingTypes`.
 */
export { type CalledToolArguments, type SearchToolNameOf } from "./script.js";
export {
  type AgentTurnFor,
  type AnswerFor,
  type FieldPartial,
  type InvalidAnswerFor,
  type IsKnown,
  type ReplyInterpreterTurnFor,
  type ReturnedOf,
  type ReturnedValueOf,
  type RouteFor,
  type RouterTurnFor,
  type ValuePartial,
} from "./script-types.js";
