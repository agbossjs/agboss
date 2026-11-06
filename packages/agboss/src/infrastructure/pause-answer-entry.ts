import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { PauseAnswerEntry } from "../terns/index.js";

/** A pause answer as a Tern store keeps it: by its tree and its step key, the record as JSON. */
export const pauseAnswerEntryOf = (
  tenantId: string,
  rootExecutionId: string,
  answer: PauseAnswerRecord,
): PauseAnswerEntry => ({
  tenantId,
  rootExecutionId,
  stepKey: answer.step.idempotencyKey,
  askedAt: answer.askedAt,
  record: JSON.stringify(answer),
});
