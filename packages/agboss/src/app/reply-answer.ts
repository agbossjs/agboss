import {
  meterOf,
  type ApplicationBudgets,
  type BudgetMeter,
  type ExecutionBudgetRecord,
} from "../budgets/execution-budgets.js";
import type { RunTracing } from "../tracing/index.js";
import type { ReplyReader } from "../channels/reply-reader.js";
import type { UsageRecord } from "../finops/usage.js";
import type { ExecutionStateType } from "../flow/runtime/state.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { AgentExecutionOutput, RunDeps } from "../run/types.js";

/**
 * A free-text reply read in the first phase of `app.resume` (#267 PR 3), before its pause is
 * closed: its interpreter's model call is checked against the tree's budgets (the amounts read at
 * its start), counted in their ledger at once and traced under the pause's execution; the spend
 * goes into the answer, so the step that takes it adds it to the execution's spend. An unreadable
 * reply throws `UninterpretableReplyError` — its call is counted too — and the pause stays pending.
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

/** What reading a reply needs from its workflow's app: its name, budgets, tracing, the tree's budgets. */
export interface ReplyAnsweringParts {
  readonly workflow: string;
  readonly budgets?: ApplicationBudgets | undefined;
  readonly tracing?: RunTracing | undefined;
  /** The budgets an execution tree keeps (the amounts read at its start), by its root's id. */
  readonly treeBudgetsOf: (rootExecutionId: string) => Promise<readonly ExecutionBudgetRecord[]>;
}

/** The tree's budgets as the reading counts them: none without the application's budgets. */
async function treeMeterOf(
  parts: ReplyAnsweringParts,
  pause: PauseRecord,
  spent: number,
): Promise<BudgetMeter | undefined> {
  if (parts.budgets === undefined) return undefined;
  return meterOf(parts.budgets, await parts.treeBudgetsOf(pause.rootExecutionId), spent);
}

/** The reading parts of a workflow's run deps: the tree's budgets read from its checkpoint. */
export const replyAnsweringPartsOf = (deps: RunDeps<string>): ReplyAnsweringParts => ({
  workflow: deps.config.name,
  budgets: deps.budgets,
  tracing: deps.tracing,
  treeBudgetsOf: async (rootExecutionId) => {
    const snapshot = await readingGraphOf(deps).getState(runConfig(rootExecutionId));
    // LangGraph boundary: a checkpoint's values are the flow's own state
    return (snapshot.values as Partial<ExecutionStateType>).budgets ?? [];
  },
});

/** The replies of a workflow's app, read by `reader`. */
export function replyAnsweringOf(parts: ReplyAnsweringParts, reader: ReplyReader): ReplyAnswering {
  return async (pause, reply, run, validate) => {
    const spent = run?.cost.totalUsd ?? 0;
    const meter = await treeMeterOf(parts, pause, spent);
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
    const reading = await reader({ pause, reply, validate, beforeModelCall, callbacks });
    await meter?.record(reading.usage);
    if (reading.kind === "unreadable") throw reading.error;
    return { decision: reading.decision, usage: reading.usage };
  };
}
