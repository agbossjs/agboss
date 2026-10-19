import { stopComponents, startComponents } from "../components/container/lifecycle.js";
import {
  standaloneBudgetsOf,
  standaloneInfrastructure,
} from "../application/application-container.js";
import type { AssembledWorkflow } from "../workflow.js";
import { createWorkflowDeps, type AppDeps, type AppDepsOptions } from "./app-deps.js";
import { standaloneChildrenOf, type StandaloneChildren } from "./child-deps.js";

/**
 * The run dependencies of one workflow on its own (eval, replay, golden, compare): on the
 * infrastructure of the application that lists it (its `providers` — e.g. the SQLite
 * implementations, so records persist across processes), else the built-in in-memory one, and
 * its own lifecycle hooks; `close()` also closes what the infrastructure opened.
 */
export async function createAppDeps(
  bundle: AssembledWorkflow,
  options: AppDepsOptions = {},
): Promise<AppDeps> {
  const opened: unknown[] = [];
  const infrastructure = standaloneInfrastructure(bundle, options, (instance) => {
    opened.push(instance);
  });
  await startComponents(opened);
  const budgets = standaloneBudgetsOf(bundle);
  const parts = { infrastructure, ...(budgets === undefined ? {} : { budgets }) };
  const built = async (): Promise<readonly [AppDeps, StandaloneChildren]> => {
    const children = await standaloneChildrenOf(bundle, (child, childDepsOf) =>
      createWorkflowDeps(child, options, { ...parts, childDepsOf }),
    );
    const own = { ...parts, childDepsOf: children.childDepsOf };
    return [await createWorkflowDeps(bundle, options, own), children];
  };
  const [deps, children] = await built().catch(async (error: unknown) => {
    await stopComponents(opened);
    throw error;
  });
  return {
    ...deps,
    close: async (executionsDone) => {
      try {
        await deps.close(executionsDone);
        await children.close();
      } finally {
        await stopComponents(opened);
      }
    },
  };
}
