import { nodeRecordIn, workflowIdentityOf } from "../flow/runtime/workflow-keys.js";
import {
  meterOf,
  type ApplicationBudgets,
  type BudgetMeter,
} from "../budgets/execution-budgets.js";
import type { ExecutionTracing } from "../tracing/index.js";
import { replyReaderOf, type ReplyPii, type ReplyReader } from "../channels/reply-reader.js";
import type { UsageRecord } from "../finops/usage.js";
import type { StepDescriptor, WorkflowDescriptor } from "../flow/context/execution-context.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { idempotencyKeyOf } from "../flow/context/idempotency.js";
import { standaloneContexts, tenantOfExecution } from "../flow/context/runtime-contexts.js";
import { DEFAULT_TENANT, type ExecutionContextValues } from "../flow/context/context-values.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import { NodeKind } from "../flow/ast.js";
import type { GraphDeps } from "../graph/deps.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import { PiiPolicySet } from "../pii/policy-set.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { AppDeps } from "./app-deps.js";

/**
 * A free-text reply read in the first phase of `app.resume` (#267 PR 3), before its pause is
 * closed: its interpreter's model call is checked against the tree's budgets (the amounts read at
 * its start), counted in their ledger at once and traced under the pause's execution; the spend
 * goes into the answer, so the step that takes it adds it to the execution's spend. An unreadable
 * reply throws `UninterpretableReplyError` — its call is counted too — and the pause stays pending.
 * The reading runs in the pause's execution frame — its tenant, its fields, the waiting step — and
 * its model reads through the application's PII policies, the execution's tokens known. Loaded
 * with the first reply (`lazyReplyAnswering`): the root import stays lean (#205).
 */

/** The decision a reply gave, and what reading it cost. */
export interface ReadReply {
  readonly decision: unknown;
  readonly usage: readonly UsageRecord[];
}

/** Reads one reply: the pause, the text, its tree's run as it rests, and the decision's validation. */
export type ReplyAnswering = (
  pause: PauseRecord,
  reply: string,
  run: AgentExecutionOutput | undefined,
  validate: (decision: unknown) => unknown,
) => Promise<ReadReply>;

/** The tree's state as its root's last checkpoint keeps it (empty before its first one). */
export type TreeState = Partial<ExecutionStateType>;

/** What reading a reply needs from its workflow's app. */
export interface ReplyAnsweringParts {
  readonly workflow: string;
  readonly budgets?: ApplicationBudgets | undefined;
  readonly tracing?: ExecutionTracing | undefined;
  /** The tree's state by its root's id: its budgets, contexts and PII tokens. */
  readonly treeStateOf: (rootExecutionId: string) => Promise<TreeState>;
  /** The frame of the pause's execution and waiting step. */
  readonly frameOf: (pause: PauseRecord, state: TreeState) => Promise<FrameSpec>;
  /** What the interpreter's model reads through: the policies and the execution's tokens. */
  readonly piiOf: (state: TreeState) => ReplyPii;
}

/** The tree's budgets as the reading counts them: none without the application's budgets. */
const treeMeterOf = (
  parts: ReplyAnsweringParts,
  state: TreeState,
  spent: number,
): BudgetMeter | undefined =>
  parts.budgets === undefined ? undefined : meterOf(parts.budgets, state.budgets ?? [], spent);

/** The execution's contexts as its state keeps them (the tenant alone before its first step). */
const contextsOf = (state: TreeState, tenantId: string): ExecutionContextValues =>
  state.contexts ?? { tenant: { ...DEFAULT_TENANT, tenantId }, execution: {} };

/** The graph deps of a workflow of the tree, by name: the root's, or a child's (#263). */
function graphDepsNamed(deps: GraphDeps<string>, name: string): GraphDeps<string> | undefined {
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
  deps: AppDeps,
  pause: PauseRecord,
  state: TreeState,
): { readonly own: GraphDeps<string>; readonly workflow: WorkflowDescriptor } {
  const own = graphDepsNamed(deps, pause.workflow) ?? deps;
  // the root's version it started on is in its state; a child's is its own (it started with it)
  const kept = own === deps ? (state.startedVersion ?? "") : "";
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

/** The frame a pause's reply is read in: its execution (tenant, fields) and its waiting step. */
async function pauseFrameOf(
  deps: AppDeps,
  pause: PauseRecord,
  state: TreeState,
): Promise<FrameSpec> {
  const { own, workflow } = pauseWorkflowOf(deps, pause, state);
  const contexts = deps.contexts ?? standaloneContexts(workflow);
  const owner = await deps.terns.threadOwner(deps.config.name, pause.tenantId, pause.threadId);
  const { tenant, execution } = contextsOf(state, pause.tenantId);
  return {
    execution: Object.freeze({
      executionId: pause.executionId,
      threadId: pause.threadId,
      ownerId: owner?.owner,
      signal: new AbortController().signal,
      workflow,
      tenant: tenantOfExecution(contexts, tenant),
      values: execution,
      itemIndex: pause.itemIndex,
    }),
    step: pauseStepOf(pause, own),
  };
}

/** The reading parts of a workflow's app: the tree's state read from its root's checkpoint. */
export const replyAnsweringPartsOf = (deps: AppDeps): ReplyAnsweringParts => ({
  workflow: deps.config.name,
  budgets: deps.budgets,
  tracing: deps.tracing,
  treeStateOf: async (rootExecutionId) => {
    const snapshot = await readingGraphOf(deps).getState(runConfig(rootExecutionId));
    // LangGraph boundary: a checkpoint's values are the flow's own state
    return snapshot.values as TreeState;
  },
  frameOf: (pause, state) => pauseFrameOf(deps, pause, state),
  piiOf: (state) => {
    const known = state.piiTokens ?? {};
    const { pii } = deps;
    if (pii === undefined) return { policies: new PiiPolicySet([], ""), known };
    const sensitive = pii.contextValuesOf(contextsOf(state, DEFAULT_TENANT.tenantId));
    // the tree's key (#334): the root's and its children's, one value one token
    const policies = pii.workflowPolicies.withValues(sensitive).withFieldKey(state.piiKey);
    return { policies, known };
  },
});

/** The replies of a workflow's app, read by `reader`. */
export function replyAnsweringOf(parts: ReplyAnsweringParts, reader: ReplyReader): ReplyAnswering {
  return async (pause, reply, run, validate) => {
    const spent = run?.cost.totalUsd ?? 0;
    const state = await parts.treeStateOf(pause.rootExecutionId);
    const meter = treeMeterOf(parts, state, spent);
    const trace = {
      bundle: parts.workflow,
      threadId: pause.threadId,
      runId: pause.rootExecutionId,
      tenantId: pause.tenantId,
    };
    const beforeModelCall = async (): Promise<void> => {
      if (meter === undefined) return;
      await meter.refresh();
      meter.check(spent, run?.path ?? []);
    };
    const callbacks = parts.tracing?.callbacks(trace) ?? [];
    const frame = await parts.frameOf(pause, state);
    const pii = parts.piiOf(state);
    const call = { pause, reply, validate, beforeModelCall, callbacks, frame, pii };
    const reading = await reader(call);
    await meter?.record(reading.usage);
    if (reading.kind === "unreadable") throw reading.error;
    return { decision: reading.decision, usage: reading.usage };
  };
}

/** The replies of a workflow's app, on its run deps (the module `lazyReplyAnswering` loads). */
export const replyAnsweringFor = (deps: AppDeps): ReplyAnswering =>
  replyAnsweringOf(replyAnsweringPartsOf(deps), replyReaderOf(deps.replies));
