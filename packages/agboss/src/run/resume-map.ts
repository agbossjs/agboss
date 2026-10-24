import { PauseStatus, type PauseRecord } from "../infrastructure/paused-execution.repository.js";
import type { WaitingInterrupt } from "./waiting-pauses.js";

/**
 * The second phase of a resume (#267 S35, Q58): one `Command({ resume })` for the whole tree, mapping
 * LangGraph's interrupt id of every pause that has its answer — `Resolved` with its decision, or
 * `Cancelled` (withdrawn, AC10) — so each of their steps runs again and takes its record; the pauses
 * without an answer stop at their `interrupt()` again.
 */
export interface TreeResume {
  /** LangGraph's interrupt id → what the step gets (its record decides; the value is the pause's id). */
  readonly values: Readonly<Record<string, string>>;
  /** Every pause it answers or withdraws: a later pass of the same drain does not take it again. */
  readonly pauseIds: readonly string[];
  /** The resolved pauses this resume takes: `Taken` once the pass has stored their steps. */
  readonly taken: readonly PauseRecord[];
  /** The decisions it takes, for `onExecutionResume`. */
  readonly decisions: readonly unknown[];
  /** Who answered them (`answeredBy` / the owner), in the same order. */
  readonly answerers: readonly (string | undefined)[];
}

const isAnswered = (pause: PauseRecord | undefined): pause is PauseRecord =>
  pause?.status === PauseStatus.Resolved || pause?.status === PauseStatus.Cancelled;

/**
 * The tree's resume from its waiting interrupts and its pauses; `undefined` when none has an answer.
 * `passed`: the pauses earlier passes of this drain answered — LangGraph lists a finished task's
 * interrupt until its superstep ends, so they are not taken twice.
 */
export function treeResumeOf(
  interrupts: readonly WaitingInterrupt[],
  pauses: readonly PauseRecord[],
  passed: ReadonlySet<string> = new Set(),
): TreeResume | undefined {
  const byId = new Map(pauses.map((pause) => [pause.pauseId, pause]));
  const answered = interrupts.flatMap((waiting) => {
    const pause = byId.get(waiting.pauseId);
    return isAnswered(pause) && !passed.has(pause.pauseId) ? [{ waiting, pause }] : [];
  });
  if (answered.length === 0) return undefined;
  const taken = answered.flatMap(({ pause }) =>
    pause.status === PauseStatus.Resolved ? [pause] : [],
  );
  return {
    values: valuesOf(answered.map(({ waiting }) => waiting)),
    pauseIds: answered.map(({ pause }) => pause.pauseId),
    taken,
    decisions: taken.map((pause) => pause.answer?.decision),
    answerers: taken.map((pause) => pause.answer?.answerer),
  };
}

/**
 * The resume map of the answered interrupts: a pause's own at its thread's level; below a waiting
 * marker (ADR-0022) the child's own map, as JSON, under the marker's id — the parent's node forwards
 * it to the child's thread.
 */
function valuesOf(answered: readonly WaitingInterrupt[]): Readonly<Record<string, string>> {
  const own: Record<string, string> = {};
  const below = new Map<string, WaitingInterrupt[]>();
  for (const waiting of answered) {
    const [marker, ...rest] = waiting.via;
    if (marker === undefined) {
      own[waiting.interruptId] = waiting.pauseId;
      continue;
    }
    below.set(marker, [...(below.get(marker) ?? []), { ...waiting, via: rest }]);
  }
  for (const [marker, inside] of below) own[marker] = JSON.stringify(valuesOf(inside));
  return own;
}
