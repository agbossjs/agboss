import type { ExecutionRecord, PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import {
  PauseResolution,
  type PauseRecord,
} from "../infrastructure/paused-execution.repository.js";
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
 * The full record of an execution (`{ record: true }`, #270 AC16); its `pauses` come from the
 * tree's pause records once the pass ended (`withPauseAnswers`, #267 S107).
 */
const recordOf = (run: AgentExecutionOutput): ExecutionRecord => ({
  path: run.path,
  scope: Object.values(run.data.scope),
  outdatedValues: run.data.outdatedValues,
  ...(run.data.lastError === null ? {} : { lastError: run.data.lastError }),
  spend: run.cost,
  children: run.data.children ?? [],
  pauses: [],
});

/** An execution of the core, as the app reports it. */
export function runResultOf(run: AgentExecutionOutput, withRecord: boolean): ExecutionOutput {
  return {
    status: run.status,
    threadId: run.threadId,
    tenantId: run.tenantId,
    runId: run.runId,
    path: run.path,
    spend: run.cost,
    launches: run.data.launches ?? [],
    children: run.data.children ?? [],
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
 * Who answered each pause and how (#267 S107): the resolved pause records of a tree, in the order
 * they were asked, as its execution record lists them — the decision masked by the application's
 * PII policies like the rest of the record, none for a withdrawn or cancelled pause, no id for a
 * `PauseAnswerer.Channel` pause.
 */

/** Whether a pause was closed without an answer. */
const isWithoutAnswer = (resolution: PauseResolution): boolean =>
  resolution === PauseResolution.Withdrawn || resolution === PauseResolution.Cancelled;

/** One resolved pause as the record shows it (before masking). */
function answerRecordOf(pause: PauseRecord, resolution: PauseResolution): PauseAnswerRecord {
  const hasAnswer = !isWithoutAnswer(resolution);
  return {
    pauseId: pause.answeredBy === PauseAnswerer.Channel ? undefined : pause.pauseId,
    step: {
      component: { name: pause.agent },
      nodeId: pause.nodeId,
      visitNumber: pause.visitNumber,
      idempotencyKey: pause.stepKey,
      callId: pause.ask.callId,
      itemIndex: pause.itemIndex,
      copyNumber: pause.copyNumber,
    },
    role: pause.channel,
    answeredBy: pause.answeredBy,
    responder: hasAnswer ? pause.answer?.answerer : undefined,
    resolution,
    askedAt: pause.askedAt,
    resolvedAt: pause.resolvedAt,
    decision: hasAnswer ? pause.answer?.decision : undefined,
  };
}

/** The resolved pauses of a tree, in the order asked (a stable sort keeps the store's order on ties). */
function pauseAnswerRecordsOf(pauses: readonly PauseRecord[]): readonly PauseAnswerRecord[] {
  return pauses
    .flatMap((pause) =>
      pause.resolution === undefined ? [] : [answerRecordOf(pause, pause.resolution)],
    )
    .sort((first, second) => first.askedAt.localeCompare(second.askedAt));
}

/** A result with its record's `pauses` read now (after the pass took and withdrew what it did). */
export async function withPauseAnswers(
  result: ExecutionOutput,
  deps: Pick<RunDeps<string>, "pause" | "pii">,
): Promise<ExecutionOutput> {
  const { record } = result;
  const pauses = deps.pause?.pauses;
  if (record === undefined || pauses === undefined) return result;
  const mask = deps.pii?.observability;
  const records = await pauses.findAllByTenantIdAndRootExecutionId(result.tenantId, result.runId);
  const answers = pauseAnswerRecordsOf(records);
  // the mask keeps the shape: every string masked, nothing else changed
  const masked = mask === undefined ? answers : ((await mask.value(answers)) as typeof answers);
  return { ...result, record: { ...record, pauses: masked } };
}
