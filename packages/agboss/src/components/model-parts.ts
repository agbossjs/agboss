import { modelArbitersOf } from "../flow/runtime/launch/runtime-launch.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import { resolvedModelProvidersOf, type WorkflowModels } from "../models/resolution.js";
import type { AssembledPii } from "../pii/assembly.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { Provider } from "./injection.js";
import type { AssembledReplyInterpreter } from "../channels/discovery.js";

/**
 * The workflow's model arbiters (#279), its reply interpreters (#267) and its model providers,
 * every model resolved to one.
 */
export function modelPartsOf(
  owner: { readonly providers?: readonly Provider[] } | undefined,
  models: Pick<WorkflowModels, "config" | "routers">,
  graph: RuntimeGraph,
  piiDetectors: AssembledPii["detectors"],
  replyInterpreters: readonly AssembledReplyInterpreter[],
): Pick<AssembledWorkflow, "arbiters" | "modelProviders" | "replyInterpreters"> {
  const arbiters = modelArbitersOf(graph.launches);
  return {
    arbiters,
    replyInterpreters,
    modelProviders: resolvedModelProvidersOf(owner?.providers, {
      ...models,
      arbiters,
      pii: { detectors: piiDetectors },
      replyInterpreters,
    }),
  };
}
