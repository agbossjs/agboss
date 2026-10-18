/** PII policies (#120): the public API — the decorator, its rules and actions, the kinds. */
export {
  PiiAction,
  PiiActionKind,
  type AnyPiiAction,
  type BlockWithRefusalAction,
  type MaskingPiiAction,
  type PiiKeptPart,
  type PiiPartOptions,
  type PiiRefusalOptions,
  type PiiReplacedPart,
  type ReplacePartAction,
  type ReplaceWithKindAction,
  type ReplaceWithTokenAction,
} from "./actions.js";
export { PiiGroup, PiiKind, type PiiTarget } from "./kinds.js";
export {
  PiiPolicy,
  pii,
  type CustomPiiPolicyOptions,
  type DeclarativePiiPolicyOptions,
  type PiiMatch,
  type PiiPolicyHandler,
  type PiiRefusal,
  type PiiRule,
} from "./pii-policy.decorator.js";
