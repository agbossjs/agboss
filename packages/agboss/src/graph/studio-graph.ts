import type { AppDeps } from "../app/app-deps.js";
import { executionGraphOf, type ExecutionGraph } from "../flow/runtime/build.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";

/**
 * The workflow's graph for LangGraph Studio: Studio runs it itself, so tracing callbacks (when on)
 * are bound to the graph. Session "studio" groups Studio runs in Langfuse. The workflow's limits
 * apply; the day's spend is read from the workflow's ledger.
 */
export function studioGraph(deps: AppDeps): ExecutionGraph {
  const graph = executionGraphOf(deps, {
    limits: deps.limits,
    spentToday: () => deps.ledger.spentToday(deps.config.name),
  });
  if (deps.tracing === undefined) return graph;
  const callbacks = deps.tracing.callbacks({
    bundle: deps.config.name,
    threadId: "studio",
    runId: "studio",
    tenantId: DEFAULT_TENANT_ID,
  });
  return graph.withConfig({ callbacks });
}
