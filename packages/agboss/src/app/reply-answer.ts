import {
  meterOf,
  type ApplicationBudgets,
  type BudgetMeter,
} from "../budgets/execution-budgets.js";
import type { ExecutionTracing } from "../tracing/index.js";
import { replyReaderOf, type ReplyPii, type ReplyReader } from "../channels/reply-reader.js";
import type { UsageRecord } from "../finops/usage.js";
import type { FrameSpec } from "../flow/context/frame.js";
import { DEFAULT_TENANT } from "../flow/context/context-values.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import { PiiPolicySet } from "../pii/policy-set.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { AppDeps } from "./app-deps.js";
import {
  contextsOf,
  pauseFrameOf,
  treeStateOf,
  withdrawalTreeOf,
  type TreeState,
} from "./pause-frame.js";

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

/** The reading parts of a workflow's app: the tree's state read from its root's checkpoint. */
export const replyAnsweringPartsOf = (deps: AppDeps): ReplyAnsweringParts => ({
  workflow: deps.config.name,
  budgets: deps.budgets,
  tracing: deps.tracing,
  treeStateOf: (rootExecutionId) => treeStateOf(deps, rootExecutionId),
  frameOf: async (pause, state) =>
    pauseFrameOf(deps, pause, await withdrawalTreeOf(deps, pause, state)),
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
