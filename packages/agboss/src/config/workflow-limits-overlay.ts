import type { Milliseconds, Ttl } from "../units/index.js";
import type { WorkflowExecutionLimits } from "../flow/decorators/workflow.js";
import type { FoldedConfig } from "./fold-config.js";
import { overlaysOf } from "./workflow-overlay.js";

/** The `executionLimits` the profiles give a workflow: per profile `"*"` then its own, each limit a later one wins. */
export function executionLimitsOverlayOf(
  folded: FoldedConfig,
  workflow: string,
): WorkflowExecutionLimits | undefined {
  const given = overlaysOf(folded, workflow).flatMap((one) =>
    one.overlay.executionLimits === undefined ? [] : [one.overlay.executionLimits],
  );
  return given.length === 0
    ? undefined
    : given.reduce<WorkflowExecutionLimits>((all, one) => ({ ...all, ...one }), {});
}

/** The `historyTtl` the profiles give a workflow: per profile `"*"` then its own, a later one winning. */
export function historyTtlOverlayOf(
  folded: FoldedConfig,
  workflow: string,
): Milliseconds | Ttl | undefined {
  return overlaysOf(folded, workflow).reduce<Milliseconds | Ttl | undefined>(
    (found, one) => one.overlay.historyTtl ?? found,
    undefined,
  );
}
