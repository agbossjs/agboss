import { workflowInApplication } from "../application/workflow-application.js";
import { workflowOf as assembleWorkflow } from "../components/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import type { AssembledWorkflow } from "../workflow.js";
import { loadApplicationInGraph } from "./application-in-graph.js";

/**
 * A workflow assembled for a unit test (its config, prompts and graph): in its
 * application — the one `*.application.ts` next to it or above that lists it, with its providers
 * and `defaults` (#261) — or on the providers given. An application file loaded outside vitest's
 * module graph (no `agbossTest()` in vitest.config.ts, #497) is a `TestSetupError`.
 */
export const workflowOf = async (
  workflow: Class,
  application?: readonly ProviderModule[],
): Promise<AssembledWorkflow> => {
  if (application !== undefined) return assembleWorkflow(workflow, application);
  await loadApplicationInGraph(workflow);
  return workflowInApplication(workflow);
};
