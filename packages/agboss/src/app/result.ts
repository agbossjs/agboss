import { compensationRecordsOf } from "../flow/compensation.js";
import { withChildPauses } from "../flow/runtime/child-records.js";
import type { ExecutionRecord, PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { AgentExecutionDeps } from "../run/types.js";
import type { AgentExecutionOutput } from "../run/types.js";
import type { ExecutionOutput } from "./types.js";
import type { ComponentRecord } from "../flow/runtime/records.js";
import { NO_OBSERVABILITY_MASK } from "../pii/observability-mask.js";
import { maskedEntries, maskedTreeRecordOf, treeMasksFor, type TreeDeps } from "./record-masks.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { pendingPauseOf, type PendingPause, type WaitingPause } from "../pause/index.js";

/** A pause as callers see it: a `Channel` pause's id stays with its channel (#267 AC3). */
const visiblePauseOf = (pause: WaitingPause): PendingPause =>
  pendingPauseOf(pause, pause.answerer === PauseAnswerer.ThreadOwner);

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
  compensations: compensationRecordsOf(run.data.compensations),
  toolCalls: run.data.toolCalls ?? [],
  steps: run.data.steps ?? [],
  ...(run.data.origin === undefined ? {} : { origin: run.data.origin }),
});

/**
 * An execution of the core, as the app reports it — one pass's: its children's pauses are filled
 * once the tree rests (`withPauseAnswers`).
 */
export function runResultOf(
  run: AgentExecutionOutput,
  withRecord: boolean,
  finishOf: (name: string) => ComponentRecord,
): ExecutionOutput {
  return {
    status: run.status,
    threadId: run.threadId,
    tenantId: run.tenantId,
    executionId: run.runId,
    path: run.path,
    spend: run.cost,
    launches: run.data.launches ?? [],
    children: withChildPauses(run.data.children ?? [], []),
    handledErrors: run.data.handledErrors ?? [],
    compensations: compensationRecordsOf(run.data.compensations),
    toolCalls: run.data.toolCalls ?? [],
    ...(run.finish === undefined ? {} : { finish: finishOf(run.finish), output: run.output }),
    pending: run.pending.map(visiblePauseOf),
    ...(run.compacted === undefined ? {} : { compacted: run.compacted }),
    ...(run.traceUrl === undefined ? {} : { traceUrl: run.traceUrl }),
    ...(withRecord ? { record: recordOf(run) } : {}),
  };
}

/**
 * The result with its record masked (#120 AC7): the root's own fields by its workflow's
 * observability policies, each child's record by its own chain's (#1150).
 */
export async function maskedRecordOf(
  result: ExecutionOutput,
  deps: TreeDeps | undefined,
): Promise<ExecutionOutput> {
  const { record } = result;
  if (record === undefined) return result;
  // no deps at all: no policies, still no file bytes (#899 §0)
  if (deps === undefined)
    return { ...result, record: (await NO_OBSERVABILITY_MASK.value(record)) as typeof record };
  const masks = treeMasksFor(deps, result.executionId, record.children);
  // the mask keeps the record's shape: every string masked, nothing else changed; no policies,
  // still no file bytes (#899 §0)
  return {
    ...result,
    record: await maskedTreeRecordOf(record, masks, result.executionId, "value"),
  };
}

/**
 * A result with its record's `pauses` (#267 S107) and each child's (S124 c): how each pause of its
 * tree was resolved, from the execution records — the permanent log, whatever the pause records'
 * retention removed — in the order they were asked, masked by the PII policies of the execution
 * that asked each (#1150: a child's by its chain's) like the rest of the record. A child's are the
 * pauses its own steps asked, in `result.children` and `result.record.children` alike; the log is
 * read only when one of them is reported.
 */
export async function withPauseAnswers(
  result: ExecutionOutput,
  deps: Pick<AgentExecutionDeps<string>, "pause"> & TreeDeps,
): Promise<ExecutionOutput> {
  const { record } = result;
  const log = deps.pause?.answers;
  if ((record === undefined && result.children.length === 0) || log === undefined) return result;
  const answers = await log.findPauseAnswersByTenantIdAndRootExecutionId(
    result.tenantId,
    result.executionId,
  );
  const masks = treeMasksFor(deps, result.executionId, record?.children ?? result.children);
  // the mask keeps the shape: every string masked, nothing else changed
  const masked = await maskedEntries(answers, masks, "value");
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
