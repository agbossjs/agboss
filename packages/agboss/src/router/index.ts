/**
 * `@agboss/core/router` — deprecated (#195): the flow DSL and the start / router / finish
 * decorators moved to the root entry `agboss`. `agboss migrate imports` rewrites the imports;
 * this entry is removed in the next minor release.
 */
export {
  /** @deprecated Import from "@agboss/core" (#195). */
  Router,
  /** @deprecated Import from "@agboss/core" (#195). */
  type RouterOptions,
  /** @deprecated Import from "@agboss/core" (#195). */
  type ToStep,
  /** @deprecated Import from "@agboss/core" (#195). */
  WorkflowFinish,
  /** @deprecated Import from "@agboss/core" (#195). */
  type WorkflowFinishOptions,
  /** @deprecated Import from "@agboss/core" (#195). */
  WorkflowStart,
  /** @deprecated Import from "@agboss/core" (#195). */
  type WorkflowStartOptions,
} from "../index.js";
