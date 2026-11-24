/** PII policies (#120, #1301): the public API — the decorator, its actions, the kinds and groups. */
export {
  PiiAction,
  PiiActionKind,
  type AnyPiiAction,
  type BlockAction,
  type MaskAction,
  type MaskingPiiAction,
  type MaskPartAction,
  type PiiKeptPart,
  type PiiPartOptions,
  type PiiReplacedPart,
  type TokenizeAction,
} from "./actions.js";
export {
  PiiGroup,
  PiiKind,
  type PiiGroupDescriptor,
  type PiiKindDescriptor,
  type PiiTarget,
  type PiiTargetDescriptor,
} from "./kinds.js";
export {
  PiiFileAction,
  PiiPolicy,
  type CustomPiiPolicyOptions,
  type DeclarativePiiPolicyOptions,
  type PiiMatch,
  type PiiPolicyHandler,
  type PiiRefusal,
  type PiiRule,
} from "./pii-policy.decorator.js";
export type { PiiRuleCode } from "./pii-rule-codes.js";
