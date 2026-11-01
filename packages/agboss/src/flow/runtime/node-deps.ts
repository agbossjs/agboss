import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import type { Class } from "../../components/injection.js";
import type { GraphDeps } from "../../graph/deps.js";
import { standaloneContexts } from "../context/runtime-contexts.js";
import type { BranchDeps } from "./launch/branch-runner.js";
import type { JoinDeps } from "./launch/join-node.js";
import { LaunchRegistry } from "./launch/launch-registry.js";
import type { VisitDeps } from "./visit.js";
import { joinKeysOf, workflowIdentityOf } from "./workflow-keys.js";
import type { TreeSlotRegistry } from "./launch/launch-registry.js";

/** What a launch's branches and join share in one pass: its registry, arbiters and stores. */
function launchDepsOf(
  deps: GraphDeps<string>,
  visitDeps: VisitDeps,
  checkpointer: BaseCheckpointSaver | undefined,
): BranchDeps & JoinDeps {
  return {
    ...visitDeps,
    registry: new LaunchRegistry(),
    container: deps.container,
    ...(deps.stepEntries === undefined ? {} : { stepEntries: deps.stepEntries }),
    // a quorum's arbiters (#279): code ones from the container, model ones on their model
    arbiters: {
      instanceOf: (arbiter: Class): unknown => deps.container.get(arbiter),
      ...(deps.arbiterModelFor === undefined ? {} : { modelOf: deps.arbiterModelFor }),
    },
    ...(checkpointer === undefined ? {} : { checkpointer }),
    ...(deps.pause === undefined ? {} : { pauses: deps.pause }),
    ...(deps.branchErrors === undefined ? {} : { branchErrors: deps.branchErrors }),
    ...(deps.branchScheduler === undefined ? {} : { scheduler: deps.branchScheduler }),
  };
}

/** A graph's visit deps and its launches' deps (#263: built once per compiled graph, children too). */
export interface NodeDeps {
  readonly visitDeps: VisitDeps;
  readonly launchDeps: BranchDeps & JoinDeps;
}

/** What every visit and every launch of the graph runs with. */
export function nodeDepsOf(
  deps: GraphDeps<string>,
  run: { readonly budgets: BudgetMeter; readonly slots: TreeSlotRegistry },
  checkpointer: BaseCheckpointSaver | undefined,
): NodeDeps {
  const keys = joinKeysOf(deps);
  const workflow = workflowIdentityOf(deps);
  const visitDeps = {
    limits: { maxSteps: deps.maxSteps, budgets: run.budgets },
    workflow,
    components: keys.components,
    contexts: deps.contexts ?? standaloneContexts(workflow),
    provenance: deps.graph.provenance,
    graph: deps.graph,
    observer: deps.observer,
    // the trees' slots of the pass (#264): shared by the graph, its children and its recursion
    slots: run.slots,
    compensation: deps.compensation,
    container: deps.container,
    ...(deps.stepEntries === undefined ? {} : { stepEntries: deps.stepEntries }),
  };
  const launchDeps = launchDepsOf(deps, visitDeps, checkpointer);
  return { visitDeps, launchDeps };
}
