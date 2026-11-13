import { z } from "zod";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import { bareRecordOf, ComponentKind } from "../flow/runtime/records.js";
import type { ExecutionRecordRepository } from "./execution-record.repository.js";
import { callIdOfPause, PauseResolution, type PauseRecord } from "./pause-record.js";
import {
  componentOfStored,
  pauseAnswerRecordOfStored,
  pauseAnswererOf,
  StoredStep,
} from "./stored-step.js";

/**
 * Where a resolved pause is written (#267 S107): the execution records — the permanent history
 * behind `ExecutionRecord.pauses` — never the pause records, which the retention removes.
 */
export type PauseAnswerLog = Pick<
  ExecutionRecordRepository,
  "savePauseAnswer" | "findPauseAnswersByTenantIdAndRootExecutionId"
>;

/** Whether a pause was closed without an answer. */
const isWithoutAnswer = (resolution: PauseResolution): boolean =>
  resolution === PauseResolution.Withdrawn ||
  resolution === PauseResolution.Cancelled ||
  resolution === PauseResolution.TreeEnded ||
  resolution === PauseResolution.Expired ||
  resolution === PauseResolution.Reassigned;

/** A resolved pause as the execution record lists it (unmasked: the record is masked when read). */
export function answerRecordOf(pause: PauseRecord, resolution: PauseResolution): PauseAnswerRecord {
  return recordOf(pause, resolution, !isWithoutAnswer(resolution));
}

/**
 * An answer no step took, as the log keeps it (I12): the answer and who gave it kept, `isTaken:
 * false`, closed as the record says (`Cancelled` or `TreeEnded`) when it was closed.
 */
export const notTakenRecordOf = (pause: PauseRecord): PauseAnswerRecord => ({
  ...recordOf(pause, pause.resolution ?? PauseResolution.Cancelled, true),
  isTaken: false,
});

/** The log entry of `pause` closed as `resolution`, with or without its answer. */
function recordOf(
  pause: PauseRecord,
  resolution: PauseResolution,
  hasAnswer: boolean,
): PauseAnswerRecord {
  const answerer = pauseAnswererOf(pause);
  const answeredBy = hasAnswer ? pause.answer?.answeredBy : undefined;
  return {
    pauseId: answerer === PauseAnswerer.Channel ? undefined : pause.pauseId,
    executionId: pause.executionId,
    step: {
      component: pause.component ?? bareRecordOf(pause.step, ComponentKind.Agent),
      nodeId: pause.nodeId,
      visitNumber: pause.visitNumber,
      idempotencyKey: pause.stepKey,
      callId: callIdOfPause(pause),
      itemIndex: pause.itemIndex,
      copyNumber: pause.copyNumber,
      toolLoopIteration: pause.toolLoopIteration,
      validationAttempts: pause.validationAttempts ?? 0,
    },
    role: pause.channel,
    answerer,
    answeredBy,
    responder: answeredBy,
    resolution,
    askedAt: pause.askedAt,
    resolvedAt: pause.resolvedAt,
    decision: hasAnswer ? pause.answer?.decision : undefined,
    asked: pause.ask,
  };
}

/** Writes that a pause's answer was not taken into its tree's execution records (wins in any order). */
export const logPauseNotTaken = (
  log: Pick<ExecutionRecordRepository, "markPauseAnswerNotTaken">,
  pause: PauseRecord,
): Promise<void> =>
  log.markPauseAnswerNotTaken(pause.tenantId, pause.rootExecutionId, notTakenRecordOf(pause));

/** Writes how a pause was resolved into its tree's execution records. */
export const logPauseAnswer = (
  log: PauseAnswerLog,
  pause: PauseRecord,
  resolution: PauseResolution,
): Promise<void> =>
  log.savePauseAnswer(pause.tenantId, pause.rootExecutionId, answerRecordOf(pause, resolution));

const optionalText = z.string().optional();
const StoredPauseAnswer = z.object({
  pauseId: optionalText,
  executionId: z.string(),
  step: StoredStep,
  role: z.string(),
  // 0.1.0's entry has no `answerer`: its `answeredBy` is the kind, `responder` the person (#934)
  answerer: z.enum(PauseAnswerer).optional(),
  answeredBy: optionalText,
  responder: optionalText,
  resolution: z.enum(PauseResolution),
  askedAt: z.string(),
  resolvedAt: optionalText,
  decision: z.unknown().optional(),
  asked: z.unknown().optional(),
  isTaken: z.literal(false).optional(),
});

/** A pause answer record as JSON stored it (`undefined` fields are left out by JSON: restored). */
export function pauseAnswerRecordOfJson(text: string): PauseAnswerRecord {
  const stored = StoredPauseAnswer.parse(JSON.parse(text));
  const { step } = stored;
  return pauseAnswerRecordOfStored({
    ...stored,
    pauseId: stored.pauseId,
    step: {
      ...step,
      component: componentOfStored(step.component),
      callId: step.callId,
      itemIndex: step.itemIndex,
      toolLoopIteration: step.toolLoopIteration,
    },
    answerer: stored.answerer,
    answeredBy: stored.answeredBy,
    responder: stored.responder,
    resolvedAt: stored.resolvedAt,
    decision: stored.decision,
    ...(stored.asked === undefined ? {} : { asked: stored.asked }),
    ...(stored.isTaken === undefined ? {} : { isTaken: stored.isTaken }),
  });
}
