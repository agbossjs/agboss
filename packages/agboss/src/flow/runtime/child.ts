import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { GraphDeps } from "../../graph/deps.js";
import type { UsageRecord } from "../../finops/usage.js";
import { randomIdGenerator } from "../../infrastructure/clock.js";
import { childWorkflowOf } from "../analyse/child-workflow.js";
import { currentFrame, depthOf, type Frame } from "../context/frame.js";
import { NodeKind } from "../ast.js";
import type { ExecutionEvent } from "../observers/execution-event.js";
import { childEntryOf, type ChildEntry } from "./child-entry.js";
import { childFailureOf, childRecordOf, ownUsageOf, type EndedChild } from "./child-exit.js";
import { childEnteredAt, childRunOf, type ChildEntered } from "./child-identity.js";
import { ChildExecutionStatus } from "./child-records.js";
import type { RuntimeNode } from "./graph-model.js";
import type { NodeOutcome, NodeRunner } from "./node-runner.js";
import { validStartInput } from "./start-input.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";
import type { WorkflowIdentity } from "./step-frame.js";
import type { ExecutionGraph } from "./build.js";
import { refuseBeyondMaxDepth } from "./recursion-launch.js";

/**
 * A child workflow as a step of its parent (#263, S24, S37): the parent's node of `W` runs the
 * child's compiled graph — registered on the node as its subgraph, so Studio shows it inside the
 * parent — on the parent's checkpoint thread, under the launching task's `checkpoint_ns` (a second
 * pass of a loop or a neighbouring item is another task, so never an earlier child's checkpoint).
 * The child starts fresh: its start's input only, no history, its own steps and `maxSteps`; it
 * inherits the parent's contexts and spends from the root's budgets (its state starts with the
 * spend so far, so every check counts the whole tree) and starts with its parent's PII tokens,
 * giving its own back on exit — with its value, or with its error to the side path that takes it
 * (#120; the tokens of its finished steps: never on the error itself). It ends at a finish — its output, of the
 * finish's class, is the parent's value — or fails (`child-exit.ts`).
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
): ExecutionStateUpdate => ({
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

/** The child's events: its own id, its parent and its root. */
const eventOf = (frame: Frame, child: EndedChild): ExecutionEvent => ({
  executionId: child.identity.executionId,
  parentExecutionId: child.identity.parentExecutionId,
  rootExecutionId: child.identity.rootExecutionId,
  threadId: frame.execution.threadId,
  tenantId: frame.execution.tenant.tenantId,
  workflow: child.workflow,
});

/** A parent's side of one child execution: its deps and its step's frame. */
interface ChildParent {
  readonly deps: GraphDeps<string>;
  readonly frame: Frame;
}

/** A child that threw: its record and spend kept, its error event, its failure as the parent sees it. */
async function failedChild(
  parent: ChildParent,
  ended: EndedChild,
  thrown: { readonly error: unknown; readonly last: ExecutionStateType | undefined },
  signal: AbortSignal,
): Promise<never> {
  const { frame } = parent;
  const { error, last } = thrown;
  const failure = childFailureOf(error, ended, ownUsageOf(last, ended.identity), signal);
  for (const record of failure.reported) frame.services.reportUsage?.(record);
  frame.services.recordChild?.(childRecordOf(ended, last, { ...failure, error: failure.thrown }));
  // what the child masked stays revealable by the parent's side path (#120)
  if (last !== undefined) frame.services.keepPiiTokens?.(last.piiTokens);
  const asError = failure.thrown instanceof Error ? failure.thrown : new Error(String(error));
  await parent.deps.observer?.onExecutionError({ ...eventOf(frame, ended), error: asError });
  throw failure.thrown;
}

/** One child execution, to its end: its value, or its failure thrown as the parent sees it. */
async function runChild(
  child: ChildGraph,
  parent: ChildParent,
  ended: EndedChild,
  run: { readonly initial: ExecutionStateUpdate; readonly config: RunnableConfig },
): Promise<{ readonly state: ExecutionStateType; readonly usage: readonly UsageRecord[] }> {
  let last: ExecutionStateType | undefined;
  try {
    const states = await child.graph.stream(run.initial, { ...run.config, streamMode: "values" });
    for await (const state of states) if (Array.isArray(state.usage)) last = state;
  } catch (error) {
    const signal = run.config.signal ?? new AbortController().signal;
    return failedChild(parent, ended, { error, last }, signal);
  }
  if (last === undefined) throw new TypeError(`${ended.workflow.name} ended without a state`);
  const usage = ownUsageOf(last, ended.identity);
  const record = childRecordOf(ended, last, { status: ChildExecutionStatus.Finished, usage });
  parent.frame.services.recordChild?.(record);
  const event = { ...eventOf(parent.frame, ended), finish: { name: last.finish } };
  await parent.deps.observer?.onExecutionEnd({ ...event, spend: record.spend });
  return { state: last, usage };
}

/** Where the child is entered from: a per-item branch (its launcher), or a single step. */
const entrySiteOf = (node: RuntimeNode, deps: GraphDeps<string>, state: ExecutionStateType) =>
  deps.graph.branchNodes.has(node.id)
    ? { graph: deps.graph, node, scope: state.scope, launcher: state.launch?.launcher ?? "" }
    : { graph: deps.graph, node, scope: state.scope, previous: state.path.at(-1) ?? "" };

/** The runner of a parent's node of a child workflow. */
export function childRunner(
  node: RuntimeNode,
  deps: GraphDeps<string>,
  child: ChildGraph,
  checkpointer?: BaseCheckpointSaver,
): NodeRunner {
  return async (state, config) => {
    const frame = parentFrame(node);
    const entry = childEntryOf(entrySiteOf(node, deps, state));
    const start = child.deps.graph.nodes.get(entry.start.name);
    if (start === undefined) throw new TypeError(`${node.id}: no start ${entry.start.name}`);
    const input = validStartInput(start, entry.input);
    const { itemIndex } = frame.step;
    const spot = {
      checkpointer,
      config,
      parent: frame,
      itemIndex,
      inheritedUsage: state.usage.length,
      idGenerator: deps.idGenerator ?? randomIdGenerator,
    };
    const entered = await childEnteredAt(spot);
    const run = childRunOf(config, frame, entered.identity, input);
    const workflow = { name: child.workflow.name, version: child.workflow.version };
    const ended: EndedChild = {
      identity: entered.identity,
      depth: depthOf(frame.execution) + 1,
      workflow: { ...workflow, startedVersion: child.workflow.version },
      launchedBy: { nodeId: frame.step.nodeId, visitNumber: frame.step.visitNumber },
      start: entry.start.name,
      input,
    };
    // a recursion launched by code past maxDepth does not start (#264): the hard stop
    if (child.isRecursive) refuseBeyondMaxDepth(deps.graph, frame, ended, state.path);
    if (entered.isNew) await deps.observer?.onExecutionStart(eventOf(frame, ended));
    const childConfig = childConfigOf(config, run, ended);
    const initial = initialOf(state, entry, input, entered);
    const done = await runChild(child, { deps, frame }, ended, { initial, config: childConfig });
    // the child's PII tokens go back to the parent with its value (#120 S84 i)
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
