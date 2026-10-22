import { NodeKind } from "../../flow/ast.js";
import type { CompensationEntry, CompensationReason } from "../../flow/compensation.js";
import { COMPENSATION_TIMEOUT } from "../../flow/compensation.js";
import type { ExecutionFacts } from "../../flow/context/frame.js";
import { standaloneContexts, tenantOfExecution } from "../../flow/context/runtime-contexts.js";
import type { UndoSite } from "../../flow/runtime/compensation/undo.js";
import { joinKeysOf, workflowIdentityOf } from "../../flow/runtime/workflow-keys.js";
import { isThisWorkflow } from "../../flow/this-workflow.js";
import type { GraphDeps } from "../../graph/deps.js";
import { systemClock } from "../../infrastructure/clock.js";
import type { AppDeps } from "../app-deps.js";
import { contextsOf, type TreeState as CheckpointState } from "../pause-frame.js";
import type { TreeState } from "../tree-move-types.js";

/**
 * Where each entry of a tree undoes when the tree ends without a finish (#340 PR 3): its
 * execution's frame — the root's from its checkpoint (its contexts) and the thread's owner, a
 * descendant's (a child not running in this process: paused, or before a crash) its own id and
 * workflow, found by its checkpoint namespace, without a parent (as a withdrawal's frame, #337) —
 * and its workflow's graph and container.
 */

/** A tree's sites: by execution id, its namespace in the checkpoint (`""` for the root). */
export interface TreeUndoSites {
  readonly deps: AppDeps;
  readonly state: TreeState;
  readonly checkpoint: CheckpointState;
  readonly ownerId: string | undefined;
  /** The undo's signal: the lease's (a lost lease is no outcome of the undo, #265). */
  readonly signal: AbortSignal;
  readonly reason: CompensationReason;
  readonly namespaces: ReadonlyMap<string, string>;
}

/** The graph deps of the execution under `namespace`: down the tree by its child nodes' names. */
export function depsOfNamespace(deps: GraphDeps<string>, namespace: string): GraphDeps<string> {
  let current = deps;
  for (const segment of namespace === "" ? [] : namespace.split("|")) {
    const node = current.graph.nodes.get(segment.split(":")[0] ?? "");
    if (node?.kind !== NodeKind.Workflow) break;
    if (!isThisWorkflow(node.component)) current = current.childDepsOf?.(node.component) ?? current;
  }
  return current;
}

/** The facts of one execution of the tree, as its undo actions' frames read them. */
function factsOf(
  sites: TreeUndoSites,
  own: GraphDeps<string>,
  executionId: string,
): ExecutionFacts {
  const { state, checkpoint } = sites;
  const identity = workflowIdentityOf(own);
  const isRoot = executionId === state.runId;
  const startedVersion = isRoot ? state.startedVersion : identity.version;
  const contexts = contextsOf(checkpoint, state.tenantId);
  const runtime = own.contexts ?? standaloneContexts(identity);
  return Object.freeze({
    executionId,
    threadId: state.threadId,
    ownerId: sites.ownerId,
    signal: sites.signal,
    workflow: Object.freeze({ ...identity, startedVersion }),
    tenant: tenantOfExecution(runtime, contexts.tenant),
    values: contexts.execution,
  });
}

/** The undo site of one entry: its execution's frame, its workflow's graph and container. */
export function undoSiteOf(sites: TreeUndoSites, entry: CompensationEntry): UndoSite {
  const { deps } = sites;
  const namespace = sites.namespaces.get(entry.executionId) ?? "";
  const own = depsOfNamespace(deps, namespace);
  return {
    ...{ graph: own.graph, container: own.container },
    components: joinKeysOf(own).components,
    observer: deps.observer,
    execution: factsOf(sites, own, entry.executionId),
    clock: deps.clock ?? systemClock,
    timeout: deps.compensation?.timeout ?? COMPENSATION_TIMEOUT,
    stepEntries: deps.stepEntries,
    reason: sites.reason,
  };
}
