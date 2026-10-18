import { createAppDeps } from "./app/app-deps.js";
import { workflowInApplication } from "./application/workflow-application.js";
import type { Class } from "./components/index.js";
import { studioGraph } from "./graph/studio-graph.js";

/**
 * A workflow's graph for LangGraph Studio: `export const graph = await studioGraphOf(MyWorkflow)` —
 * assembled in its application (its providers and `defaults`, #261) once that module is loaded.
 */
export async function studioGraphOf(workflow: Class): Promise<ReturnType<typeof studioGraph>> {
  return studioGraph(await createAppDeps(await workflowInApplication(workflow)));
}
