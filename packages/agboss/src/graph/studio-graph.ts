import type { AppDeps } from "../app/app-deps.js";
import type { ExecutionGraph } from "../flow/runtime/build.js";
import { readingGraphOf } from "../run/run-budgets.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";

/**
 * The workflow's graph for LangGraph Studio: Studio runs it itself, so tracing callbacks (when on)
 * are bound to the graph. Session "studio" groups Studio runs in Langfuse. Its steps and visits
 * are limited; budgets are not — they are opened per execution by the app, and Studio starts its
 * executions itself.
 */
export function studioGraph(deps: AppDeps): ExecutionGraph {
  const graph = readingGraphOf(deps);
  if (deps.tracing === undefined) return graph;
  const callbacks = deps.tracing.callbacks({
    bundle: deps.config.name,
    threadId: "studio",
    runId: "studio",
    tenantId: DEFAULT_TENANT_ID,
  });
  return graph.withConfig({ callbacks });
}
