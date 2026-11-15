import { graphDepsNamed } from "../app/own-deps.js";
import type { BuiltApp } from "../app/create-app.js";
import { listPausesIn } from "../app/pause-listing.js";
import type { App } from "../app/types.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";

/**
 * Every workflow's observability mask in turn: what any of their policies hides is hidden (each
 * mask holds the application's own policies too). For a pause whose workflow the application no
 * longer lists — fail closed (#943).
 */
function unionMaskOf(workflows: readonly BuiltApp[]): ObservabilityMask | undefined {
  const masks = workflows.flatMap((workflow) => workflow.deps.pii?.observability ?? []);
  if (masks.length === 0) return undefined;
  return {
    value: async (value) => {
      let masked = value;
      for (const mask of masks) masked = await mask.value(masked);
      return masked;
    },
    text: (text) => masks.reduce((masked, mask) => mask.text(masked), text),
    traceData: async (data) => {
      let masked = data;
      for (const mask of masks) masked = await mask.traceData(masked);
      return masked;
    },
  };
}

/**
 * The observability mask of the workflow a pause waits in (#943, V11.1): its own, found by its
 * root's workflow (a child's pause: the thread's); a pause of a workflow the application does not
 * list is masked with the union of all the application's workflows' policies.
 */
export function pauseMaskOf(
  workflows: readonly BuiltApp[],
  ofThread: (threadId: string, tenantId: string) => Promise<BuiltApp | undefined>,
): (pause: PauseRecord) => Promise<ObservabilityMask | undefined> {
  const union = unionMaskOf(workflows);
  return async (pause) => {
    const root =
      pause.executionId === pause.rootExecutionId
        ? workflows.find((workflow) => workflow.deps.config.name === pause.workflow)
        : await ofThread(pause.threadId, pause.tenantId);
    const own = root === undefined ? undefined : graphDepsNamed(root.deps, pause.workflow);
    return own?.pii?.observability ?? union;
  };
}

/** `app.listPauses` of an application: its pause store, each pause masked by its own workflow's policies. */
export const listPausesOf = (
  workflows: readonly BuiltApp[],
  ofThread: (threadId: string, tenantId: string) => Promise<BuiltApp | undefined>,
  pauses: PausedExecutionRepository,
): App["listPauses"] => {
  const maskOf = pauseMaskOf(workflows, ofThread);
  return (query) => listPausesIn({ pauses, maskOf }, query);
};
