import { nodeRecordIn, workflowIdentityOf } from "../flow/runtime/workflow-keys.js";
import type { StepDescriptor, WorkflowDescriptor } from "../flow/context/execution-context.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { idempotencyKeyOf } from "../flow/context/idempotency.js";
import { standaloneContexts, tenantOfExecution } from "../flow/context/runtime-contexts.js";
import { DEFAULT_TENANT, type ExecutionContextValues } from "../flow/context/context-values.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { NodeKind } from "../flow/ast.js";
import type { GraphDeps } from "../graph/deps.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { WithdrawalTree } from "../pause/index.js";
import type { AppDeps } from "./app-deps.js";

/**
 * The frame of a pause's execution and waiting step, rebuilt outside its step: what a free-text
 * reply is read in (#267 PR 3) and what a channel's `withdraw` runs in (#337) — its tenant, its
 * fields, its owner, its step. Loaded with the modules that use it, never by the root import.
 */

/** The tree's state as its root's last checkpoint keeps it (empty before its first one). */
export type TreeState = Partial<ExecutionStateType>;

/** The root's state read from its checkpoint (its contexts, budgets, PII tokens). */
export async function treeStateOf(deps: AppDeps, rootExecutionId: string): Promise<TreeState> {
  const snapshot = await readingGraphOf(deps).getState(runConfig(rootExecutionId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  return snapshot.values as TreeState;
}

/** The execution's contexts as its state keeps them (the tenant alone before its first step). */
export const contextsOf = (state: TreeState, tenantId: string): ExecutionContextValues =>
  state.contexts ?? { tenant: { ...DEFAULT_TENANT, tenantId }, execution: {} };

/** The tree a pause's frame is made from, read from its checkpoint and its thread's owner. */
export async function withdrawalTreeOf(
  deps: AppDeps,
  pause: PauseRecord,
  state: TreeState,
): Promise<WithdrawalTree> {
  const owner = await deps.terns.threadOwner(deps.config.name, pause.tenantId, pause.threadId);
  return {
    contexts: contextsOf(state, pause.tenantId),
    ownerId: owner?.owner,
    startedVersion: state.startedVersion ?? "",
  };
}

/** The graph deps of a workflow of the tree, by name: the given one's, or a child's (#263). */
export function graphDepsNamed(
  deps: GraphDeps<string>,
  name: string,
): GraphDeps<string> | undefined {
  if (deps.config.name === name) return deps;
  for (const node of deps.graph.nodes.values()) {
    const child = node.kind === NodeKind.Workflow ? deps.childDepsOf?.(node.component) : undefined;
    const found = child === undefined ? undefined : graphDepsNamed(child, name);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The workflow a pause waits in, as its frame names it, and its graph deps. */
function pauseWorkflowOf(
  deps: GraphDeps<string>,
  pause: PauseRecord,
  tree: WithdrawalTree,
): { readonly own: GraphDeps<string>; readonly workflow: WorkflowDescriptor } {
  const own = graphDepsNamed(deps, pause.workflow) ?? deps;
  // the version it started on is the tree's for the workflow given; a child's is its own
  const kept = own === deps ? tree.startedVersion : "";
  const identity = workflowIdentityOf(own);
  const startedVersion = kept === "" ? identity.version : kept;
  return { own, workflow: { ...identity, startedVersion } };
}

/** The waiting step of a pause: its agent, node, visit, item, copy and tool call. */
function pauseStepOf(pause: PauseRecord, own: GraphDeps<string>): StepDescriptor {
  const { executionId, nodeId, visitNumber, itemIndex } = pause;
  const callId = pause.ask.callId;
  const type = own.graph.nodes.get(pause.agent)?.component ?? own.graph.type;
  return Object.freeze({
    component: { type, ...nodeRecordIn(own, pause.agent) },
    nodeId,
    visitNumber,
    idempotencyKey: idempotencyKeyOf({ executionId, nodeId, visitNumber, itemIndex, callId }),
    callId,
    itemIndex,
    copyNumber: pause.copyNumber,
    toolLoopIteration: pause.toolLoopIteration,
    validationAttempts: pause.validationAttempts ?? 0,
  });
}

/** The frame of a pause's execution (tenant, fields, owner) and waiting step; `signal` its own. */
export function pauseFrameOf(
  deps: GraphDeps<string>,
  pause: PauseRecord,
  tree: WithdrawalTree,
  signal: AbortSignal = new AbortController().signal,
): FrameSpec {
  const { own, workflow } = pauseWorkflowOf(deps, pause, tree);
  const contexts = deps.contexts ?? standaloneContexts(workflow);
  const { tenant, execution } = tree.contexts;
  return {
    execution: Object.freeze({
      executionId: pause.executionId,
      threadId: pause.threadId,
      ownerId: tree.ownerId,
      signal,
      workflow,
      tenant: tenantOfExecution(contexts, tenant),
      values: execution,
      itemIndex: pause.itemIndex,
    }),
    step: pauseStepOf(pause, own),
  };
}
