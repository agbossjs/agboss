import type { DefaultsLevels } from "../config/defaults.js";
import { rememberDefaultsLevels } from "../config/defaults.js";
import type { FlowAnalysis } from "../flow/analyse/analyse.js";
import { runtimeGraphOf, type RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { Class } from "./injection.js";
import { workflowDeclarationOf } from "./module.js";
import { memoryOf, placementsOf, windowOf, type WorkflowPatch } from "./profiled.js";

/** What a workflow\'s runtime graph is read from of its application: its defaults, and what the profiles change. */
type GraphOwner = NonNullable<DefaultsLevels["application"]> & { readonly patch?: WorkflowPatch };

/** The levels the workflow's defaults come from: its application's (if any) and its own. */
const levelsOf = (workflow: Class, owner: GraphOwner | undefined): DefaultsLevels => {
  const { options } = workflowDeclarationOf(workflow);
  return {
    ...(owner === undefined ? {} : { application: owner }),
    workflow: {
      name: options.name,
      defaults: options.defaults,
      uncompactedTurns: windowOf(memoryOf(options, owner?.patch), owner?.patch),
    },
  };
};

/** The workflow's runtime graph, with the levels its defaults came from remembered (#261). */
export function graphOf(
  analysis: FlowAnalysis,
  workflow: Class,
  owner: GraphOwner | undefined,
): RuntimeGraph {
  const { flow } = workflowDeclarationOf(workflow).options;
  const graph = runtimeGraphOf(analysis, flow, workflow, placementsOf(owner));
  rememberDefaultsLevels(graph, levelsOf(workflow, owner));
  return graph;
}
