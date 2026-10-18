import { workflowInApplication } from "../application/workflow-application.js";
import { workflowOf as assembleWorkflow } from "../components/assemble.js";
import type { ProviderModule } from "../components/container/registrations.js";
import type { Class } from "../components/injection.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * A workflow assembled for a unit test (its prompts, its `describeWorkflow` lines): in its
 * application — the one `*.application.ts` next to it or above that lists it, with its providers
 * and `defaults` (#261) — or on the providers given.
 */
export const workflowOf = (
  workflow: Class,
  application?: readonly ProviderModule[],
): Promise<AssembledWorkflow> =>
  application === undefined
    ? workflowInApplication(workflow)
    : assembleWorkflow(workflow, application);
