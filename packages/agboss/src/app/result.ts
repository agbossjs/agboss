import { withChildPauses } from "../flow/runtime/child-records.js";
import type { ExecutionRecord, PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { RunDeps } from "../run/types.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { ExecutionOutput } from "./types.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { pendingPauseOf, type PendingPause, type WaitingPause } from "../pause/index.js";

/** A pause as callers see it: a `Channel` pause's id stays with its channel (#267 AC3). */
const visiblePauseOf = (pause: WaitingPause): PendingPause =>
  pendingPauseOf(pause, pause.answeredBy === PauseAnswerer.ThreadOwner);

/**
 * The full record of an execution (`{ record: true }`, #270 AC16); its `pauses`, and its children's,
 * are read once the tree rests (`withPauseAnswers`, #267 S107 / S124 c).
 */
const recordOf = (run: AgentExecutionOutput): ExecutionRecord => ({
  path: run.path,
  scope: Object.values(run.data.scope),
  outdatedValues: run.data.outdatedValues,
  ...(run.data.lastError === null ? {} : { lastError: run.data.lastError }),
  spend: run.cost,
  children: withChildPauses(run.data.children ?? [], []),
  pauses: [],
});

/**
 * An execution of the core, as the app reports it — one pass's: its children's pauses are filled
 * once the tree rests (`withPauseAnswers`).
 */
export function runResultOf(run: AgentExecutionOutput, withRecord: boolean): ExecutionOutput {
  return {
    status: run.status,
    threadId: run.threadId,
    tenantId: run.tenantId,
    runId: run.runId,
    path: run.path,
    spend: run.cost,
    launches: run.data.launches ?? [],
    children: withChildPauses(run.data.children ?? [], []),
    handledErrors: run.data.handledErrors ?? [],
    ...(run.finish === undefined ? {} : { finish: { name: run.finish }, output: run.output }),
    pending: run.pending.map(visiblePauseOf),
    ...(run.compacted === undefined ? {} : { compacted: run.compacted }),
    ...(run.traceUrl === undefined ? {} : { traceUrl: run.traceUrl }),
    ...(withRecord ? { record: recordOf(run) } : {}),
  };
}

/** The result with its record masked by the workflow's observability policies (#120 AC7). */
export async function maskedRecordOf(
  result: ExecutionOutput,
  mask: ObservabilityMask | undefined,
): Promise<ExecutionOutput> {
  if (result.record === undefined || mask === undefined) return result;
  // the mask keeps the record's shape: every string masked, nothing else changed
  return { ...result, record: (await mask.value(result.record)) as ExecutionRecord };
}

/**
 * A result with its record's `pauses` (#267 S107) and each child's (S124 c): how each pause of its
 * tree was resolved, from the execution records — the permanent log, whatever the pause records'
 * retention removed — in the order they were asked, masked by the application's PII policies like
 * the rest of the record. A child's are the pauses its own steps asked, in `result.children` and
 * `result.record.children` alike; the log is read only when one of them is reported.
 */
export async function withPauseAnswers(
  result: ExecutionOutput,
  deps: Pick<RunDeps<string>, "pause" | "pii">,
): Promise<ExecutionOutput> {
  const { record } = result;
  const log = deps.pause?.answers;
  if ((record === undefined && result.children.length === 0) || log === undefined) return result;
  const mask = deps.pii?.observability;
  const answers = await log.findPauseAnswersByTenantIdAndRootExecutionId(
    result.tenantId,
    result.runId,
  );
  // the mask keeps the shape: every string masked, nothing else changed
  const masked = mask === undefined ? answers : ((await mask.value(answers)) as typeof answers);
  return withAnswers(result, masked);
}

/** The result with the tree's answers: the root's record's, and each child's own. */
function withAnswers(
  result: ExecutionOutput,
  answers: readonly PauseAnswerRecord[],
): ExecutionOutput {
  const { record } = result;
  const children = withChildPauses(result.children, answers);
  if (record === undefined) return { ...result, children };
  const recorded = {
    ...record,
    pauses: answers,
    children: withChildPauses(record.children, answers),
  };
  return { ...result, children, record: recorded };
}
