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
    values: Object.fromEntries(
      answered.map(({ waiting }) => [waiting.interruptId, waiting.pauseId]),
    ),
    pauseIds: answered.map(({ pause }) => pause.pauseId),
    taken,
    decisions: taken.map((pause) => pause.resolution?.decision),
    answerers: taken.map((pause) => pause.resolution?.answerer),
  };
}
