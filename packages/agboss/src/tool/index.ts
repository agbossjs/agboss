/**
 * `@agboss/core/tool` — deprecated (#195): the `@Tool` decorator and its types moved to the root
 * entry `agboss`. `agboss migrate imports` rewrites the imports; this entry is removed in the
 * next minor release.
 */
export {
  /** @deprecated Import from "@agboss/core" (#195). */
  Tool,
  /** @deprecated Import from "@agboss/core" (#195). */
  type ToolHandler,
  /** @deprecated Import from "@agboss/core" (#195). */
  type ToolOptions,
} from "../index.js";
