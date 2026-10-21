/**
 * `agboss/graph` — deprecated (#195): the flow DSL, workflow settings and limits moved to
 * the root entry `agboss`. `agboss migrate imports` rewrites the imports; this entry is removed
 * in the next minor release.
 */
export {
  /** @deprecated Import from "agboss" (#195). */
  GraphRuleError,
  /** @deprecated Import from "agboss" (#195). */
  LimitExceededError,
  /** @deprecated Import from "agboss" (#195). */
  optional,
  /** @deprecated Import from "agboss" (#195). */
  Router,
  /** @deprecated Import from "agboss" (#195). */
  RouterDecisionError,
  /** @deprecated Import from "agboss" (#195). */
  type RouterOptions,
  /** @deprecated Import from "agboss" (#195). */
  type RuleCode,
  /** @deprecated Import from "agboss" (#195). */
  type RuleViolation,
  /** @deprecated Import from "agboss" (#195). */
  type ExecutionId,
  /** @deprecated Import from "agboss" (#195). */
  type ToStep,
  /** @deprecated Import from "agboss" (#195). */
  type WorkflowDefinition,
  /** @deprecated Import from "agboss" (#195). */
  WorkflowFinish,
  /** @deprecated Import from "agboss" (#195). */
  type WorkflowFinishOptions,
  /** @deprecated Import from "agboss" (#195). */
  WorkflowSettings,
  /** @deprecated Import from "agboss" (#195). */
  type WorkflowSettingsBuilder,
  /** @deprecated Import from "agboss" (#195). */
  WorkflowStart,
  /** @deprecated Import from "agboss" (#195). */
  type WorkflowStartOptions,
} from "../index.js";
