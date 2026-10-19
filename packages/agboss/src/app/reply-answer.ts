import { meterOf, type BudgetMeter } from "../budgets/execution-budgets.js";
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

/** The tree's budgets as the reading counts them: none without the application's budgets. */
async function treeMeterOf(
  deps: RunDeps<string>,
  pause: PauseRecord,
  spent: number,
): Promise<BudgetMeter | undefined> {
  if (deps.budgets === undefined) return undefined;
  const snapshot = await readingGraphOf(deps).getState(runConfig(pause.rootExecutionId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const { budgets } = snapshot.values as Partial<ExecutionStateType>;
  return meterOf(deps.budgets, budgets ?? [], spent);
}

/** The replies of a workflow's app, read by `reader` on its deps. */
export function replyAnsweringOf(deps: RunDeps<string>, reader: ReplyReader): ReplyAnswering {
  return async (pause, reply, run, validate) => {
    const spent = run?.cost.totalUsd ?? 0;
    const meter = await treeMeterOf(deps, pause, spent);
    const trace = {
      bundle: deps.config.name,
      threadId: pause.threadId,
      runId: pause.rootExecutionId,
      tenantId: pause.tenantId,
    };
    const beforeModelCall = async (): Promise<void> => {
      if (meter === undefined) return;
      await meter.refresh();
      meter.check(spent, run?.path ?? []);
    };
    const callbacks = deps.tracing?.callbacks(trace) ?? [];
    const reading = await reader({ pause, reply, validate, beforeModelCall, callbacks });
    await meter?.record(reading.usage);
    if (reading.kind === "unreadable") throw reading.error;
    return { decision: reading.decision, usage: reading.usage };
  };
}
