import { joinKeysOf, recordOfNode } from "./workflow-keys.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { GraphDeps } from "../../graph/deps.js";
import type { BudgetMeter } from "../../budgets/execution-budgets.js";
import { inStepEntry } from "./step-entries.js";
import { eventOf, failedChild, type ChildParent } from "./child-failure.js";
import type { UsageRecord } from "../../finops/usage.js";
import { randomIdGenerator } from "../../infrastructure/clock.js";
import { childWorkflowOf } from "../analyse/child-workflow.js";
import { currentFrame, depthOf, type Frame } from "../context/frame.js";
import { NodeKind } from "../ast.js";
import { childEntryOf, type ChildEntry } from "./child-entry.js";
import { childRecordOf, ownUsageOf, type EndedChild } from "./child-exit.js";
import { childEnteredAt, childRunOf, type ChildEntered } from "./child-identity.js";
import { ChildExecutionStatus } from "./child-records.js";
import type { RuntimeNode } from "./graph-model.js";
import type { NodeOutcome, NodeRunner } from "./node-runner.js";
import { validStartInput } from "./start-input.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";
import type { WorkflowIdentity } from "./step-frame.js";
import type { ExecutionGraph } from "./build.js";
import { refuseBeyondMaxDepth } from "./recursion-launch.js";
import { interruptedUndoOf } from "./child-reentry.js";
import { childEndOf } from "./child-own-thread.js";
import { remoteChildEndOf, type RemoteChildSite } from "./remote/remote-child.js";
import { remoteSiteOf } from "./remote/remote-child-site.js";
import type { ChildInitialState } from "./remote/remote-child-run.js";

/**
 * A child workflow as a step of its parent (#263, S37; ADR-0022): the parent's node of `W` runs the
 * child's compiled graph — registered on the node as its subgraph, so Studio shows it inside the
 * parent — as a run of its own: a root graph on its own checkpoint thread, awaited in the parent's
 * step (`child-own-thread.ts`; a child started before ADR-0022 under the launching task's
 * `checkpoint_ns`, the old way). The child starts fresh: its start's input only, no history, its own
 * steps and `maxSteps`; it inherits the parent's contexts and spends from the root's budgets (its
 * state starts with the spend so far, so every check counts the whole tree) and starts with its
 * parent's PII tokens, giving its own back on exit — with its value, or with its error to the side
 * path that takes it (#120; the tokens of its finished steps: never on the error itself). It ends at
 * a finish — its output, of the finish's class, is the parent's value — or fails (`child-exit.ts`).
 */

/** The child's graph for one pass of its parent: what a parent's node of the child runs. */
export interface ChildGraph {
  readonly deps: GraphDeps<string>;
  readonly workflow: WorkflowIdentity;
  /** The child's compiled graph, streamed inside the parent's step. */
  readonly graph: ExecutionGraph;
  /**
   * `ThisWorkflow` (#264): the workflow's own graph, taken from the registry when the step runs —
   * never the node's subgraph (a graph cannot contain itself) — and held to `maxDepth`.
   */
  readonly isRecursive: boolean;
}

/** The parent's frame: a child runs only inside a step of its parent. */
function parentFrame(node: RuntimeNode): Frame {
  const frame = currentFrame();
  if (frame === undefined || frame.isClosed())
    throw new TypeError(`${node.id}: a child workflow ran outside a step of its parent`);
  return frame;
}

/** The child's value: its finish's output, with the finish's class when it gives several. */
function valueOf(child: ChildGraph, state: ExecutionStateType): NodeOutcome["value"] {
  const finish = child.deps.graph.nodes.get(state.finish)?.declaration;
  const output = finish?.kind === NodeKind.Finish ? finish.options.output : undefined;
  const outputs = childWorkflowOf(child.workflow.type)?.outputs ?? [];
  const isOneOf = outputs.length > 1 && output !== undefined;
  return isOneOf ? { value: state.output, variant: output.name } : { value: state.output };
}

/** The child's first state: its start and input, the parent's contexts and spend, its identity. */
const initialOf = (
  state: ExecutionStateType,
  entry: ChildEntry,
  input: unknown,
  entered: ChildEntered,
): ChildInitialState => ({
  runId: entered.identity.executionId,
  start: entry.start.name,
  startInput: input,
  contexts: state.contexts,
  usage: [...state.usage],
  budgets: state.budgets,
  budgetUsd: state.budgetUsd,
  // the parent's PII tokens (#120): the child's boundary reveals and masks with them too
  piiTokens: state.piiTokens,
  // and its key (#334): parent and child give one value one token
  piiKey: state.piiKey,
  child: entered.identity,
});

/** How a child run is entered: its first state, its config, and where its state lives. */
interface ChildRun {
  readonly initial: ExecutionStateUpdate;
  readonly config: RunnableConfig;
  /** Its interrupted undo's error (#340 PR 4): it takes no step, its undo is finished. */
  readonly interrupted: unknown;
  readonly entered: ChildEntered;
  /** The parent's node of the child: the child's graph is registered on it (Studio). */
  readonly node: string;
  /** A child on any instance (#333 PR 2): queued, and awaited in this step. */
  readonly remote?: RemoteChildSite | undefined;
}

/** One child execution, to its end: its value, or its failure thrown as the parent sees it. */
async function runChild(
  child: ChildGraph,
  parent: ChildParent,
  ended: EndedChild,
  run: ChildRun,
): Promise<{ readonly state: ExecutionStateType; readonly usage: readonly UsageRecord[] }> {
  if (run.interrupted !== undefined)
    return failedChild(parent, ended, { error: run.interrupted, last: undefined }, run.config);
  const end =
    run.remote === undefined
      ? await childEndOf(child, run)
      : await remoteChildEndOf(child.graph, run.config, run.remote);
  if (end.failed)
    return failedChild(parent, ended, { error: end.error, last: end.state }, run.config);
  const last = end.state;
  if (last === undefined) throw new TypeError(`${ended.workflow.name} ended without a state`);
  const usage = ownUsageOf(last, ended.identity);
  const record = childRecordOf(ended, last, { status: ChildExecutionStatus.Finished, usage });
  parent.frame.services.recordChild?.(record);
  const event = {
    ...eventOf(parent.frame, ended),
    finish: recordOfNode(ended.records, last.finish),
  };
  await parent.deps.observer?.onExecutionEnd({ ...event, spend: record.spend });
  return { state: last, usage };
}

/** Where the child is entered from: a per-item branch (its launcher), or a single step. */
const entrySiteOf = (node: RuntimeNode, deps: GraphDeps<string>, state: ExecutionStateType) =>
  deps.graph.branchNodes.has(node.id)
    ? { graph: deps.graph, node, scope: state.scope, launcher: state.launch?.launcher ?? "" }
    : { graph: deps.graph, node, scope: state.scope, previous: state.path.at(-1) ?? "" };

const endedChildOf = (
  child: ChildGraph,
  frame: ReturnType<typeof parentFrame>,
  entered: Awaited<ReturnType<typeof childEnteredAt>>,
  startName: string,
  input: unknown,
): EndedChild => ({
  identity: entered.identity,
  depth: depthOf(frame.execution) + 1,
  workflow: { ...child.workflow, startedVersion: child.workflow.version },
  launchedBy: { nodeId: frame.step.nodeId, visitNumber: frame.step.visitNumber },
  start: startName,
  input,
  records: { components: joinKeysOf(child.deps).components, graph: child.deps.graph },
});

/** The runner of a parent's node of a child workflow. */
export function childRunner(
  node: RuntimeNode,
  deps: GraphDeps<string>,
  child: ChildGraph,
  pass: { readonly checkpointer?: BaseCheckpointSaver | undefined; readonly budgets?: BudgetMeter },
): NodeRunner {
  const { checkpointer } = pass;
  return async (state, config) => {
    const frame = parentFrame(node);
    const entry = childEntryOf(entrySiteOf(node, deps, state));
    const start = child.deps.graph.nodes.get(entry.start.name);
    if (start === undefined) throw new TypeError(`${node.id}: no start ${entry.start.name}`);
    const input = validStartInput(start, entry.input);
    const idGenerator = deps.idGenerator ?? randomIdGenerator;
    const itemIndex = frame.step.itemIndex;
    const inheritedUsage = state.usage.length;
    const entered = await childEnteredAt({
      checkpointer,
      config,
      parent: frame,
      itemIndex,
      inheritedUsage,
      idGenerator,
    });
    const run = childRunOf(config, frame, entered.identity, input, child.deps.pii?.observability);
    const ended = endedChildOf(child, frame, entered, entry.start.name, input);
    if (child.isRecursive) refuseBeyondMaxDepth(deps.graph, frame, ended, state.path);
    if (entered.isNew) await deps.observer?.onExecutionStart(eventOf(frame, ended));
    const childConfig = childConfigOf(config, run, ended);
    const initial = initialOf(state, entry, input, entered);
    const undo = { child, run, checkpointer, budgets: pass.budgets };
    const interrupted = await interruptedUndoOf(deps, entered, frame.execution.tenant.tenantId);
    const isRecursive = child.isRecursive;
    const remote = remoteSiteOf(node, deps, {
      frame,
      entered,
      run,
      initial,
      ended,
      isRecursive,
      checkpointer,
    });
    const call = { initial, config: childConfig, interrupted, entered, node: node.id, remote };
    const done = await inStepEntry(deps.stepEntries, frame, () =>
      runChild(child, { deps, frame, undo }, ended, call),
    );
    const { piiTokens } = done.state;
    return { value: valueOf(child, done.state), read: entry.read, usage: done.usage, piiTokens };
  };
}

/** The child's config: the parent's (its thread, namespace and callbacks) with the child's run. */
function childConfigOf(
  config: RunnableConfig | undefined,
  run: ReturnType<typeof childRunOf>,
  child: EndedChild,
): RunnableConfig {
  const { identity, workflow } = child;
  return {
    ...config,
    signal: run.signal,
    runName: workflow.name,
    configurable: { ...config?.configurable, run },
    metadata: {
      ...config?.metadata,
      executionId: identity.executionId,
      parentExecutionId: identity.parentExecutionId,
      rootExecutionId: identity.rootExecutionId,
      workflowName: workflow.name,
      workflowVersion: workflow.version,
      depth: child.depth,
      ...(identity.itemIndex === undefined ? {} : { itemIndex: identity.itemIndex }),
    },
  };
}
