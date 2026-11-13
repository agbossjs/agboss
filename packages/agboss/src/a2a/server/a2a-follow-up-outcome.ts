import type { A2AError } from "@a2a-js/sdk/errors";
import { NotPausedError, UnknownPauseError } from "../../run/resume-agent.js";
import {
  ReplyInterpreterMissingError,
  UninterpretableReplyError,
} from "../../channels/decision.js";
import { DtoValidationError } from "../../dto/errors.js";
import type { A2ATaskKey } from "../../infrastructure/a2a-task.repository.js";
import { PauseClosedError } from "../../app/pause-closed-error.js";
import { PauseClosedReason } from "../../infrastructure/pause-record.js";
import { ThreadOwnerError } from "../../core/errors.js";
import { logSubjectOf, type A2AServerParts } from "./a2a-server-parts.js";
import {
  A2AInternalError,
  invalidParams,
  pauseClosedRefusal,
  taskNotFound,
  unsupportedOperation,
} from "./a2a-wire-errors.js";

/**
 * A follow-up's outcome (#808): accepted, or refused with a stable code and its fixed text — kept
 * with its message, so a resend replays it — and how a resume that threw is read.
 */

/** The one code of a follow-up to a closed pause (#939); its `reason` says why. */
export const PAUSE_CLOSED = "a2a.pause-closed";

/** What a follow-up was answered, kept with its message: replayed to a resend. */
export type KeptReply =
  | { readonly accepted: true; readonly answered?: number }
  | {
      readonly refused: "invalid-params" | "unsupported" | "not-found";
      readonly code: string;
      /** `a2a.pause-closed`: why the pause closed, and when (ISO 8601). */
      readonly reason?: PauseClosedReason;
      readonly closedAt?: string;
    };

const REFUSAL_TEXT: Readonly<Record<string, string>> = {
  "a2a.no-pending-pause": "the task waits for no answer of yours",
  "a2a.pause-required": "name the pause to answer",
  "a2a.unknown-pause": "the task waits for no such pause",
  "a2a.already-answered": "the pause no longer waits for an answer", // kept replies of before
  "a2a.reply-not-understood": "the reply was not understood",
  "a2a.decision-invalid": "the decision does not fit the pause",
  "a2a.task-over": "the task is over: it takes no more input",
};

/** The fixed text of each reason a pause closed (#807: never an error's own message). */
const REASON_TEXT: Readonly<Record<PauseClosedReason, string>> = {
  [PauseClosedReason.Answered]: "the pause was already answered",
  [PauseClosedReason.Expired]: "the pause expired",
  [PauseClosedReason.Cancelled]: "the task was cancelled",
  [PauseClosedReason.Withdrawn]: "the pause is no longer needed",
  [PauseClosedReason.TreeEnded]: "the task is over",
  [PauseClosedReason.Reassigned]: "the pause moved to someone else",
};

export const refusalOf = (kept: Exclude<KeptReply, { readonly accepted: true }>): A2AError => {
  const text = REFUSAL_TEXT[kept.code] ?? "the answer was refused";
  if (kept.refused === "not-found") return taskNotFound();
  if (kept.code === PAUSE_CLOSED && kept.reason !== undefined && kept.closedAt !== undefined)
    return pauseClosedRefusal(kept.reason, REASON_TEXT[kept.reason], kept.closedAt);
  return kept.refused === "unsupported"
    ? unsupportedOperation(kept.code, text)
    : invalidParams(kept.code, text);
};

export const isKeptReply = (value: unknown): value is KeptReply =>
  typeof value === "object" && value !== null && ("accepted" in value || "refused" in value);

/** A resume that threw before its pause was resolved, as its refusal; `undefined`: it was accepted. */
function refusedResume(error: unknown, isStillPending: boolean): KeptReply | undefined {
  if (error instanceof PauseClosedError)
    return {
      refused: "unsupported",
      code: PAUSE_CLOSED,
      reason: error.reason,
      closedAt: error.closedAt,
    };
  // a thread-level miss: the tree no longer rests (a cancel dropped it) — no pause to name
  if (error instanceof NotPausedError)
    return { refused: "unsupported", code: "a2a.no-pending-pause" };
  if (error instanceof UnknownPauseError)
    return { refused: "invalid-params", code: "a2a.unknown-pause" };
  if (error instanceof ThreadOwnerError) return { refused: "not-found", code: "a2a.not-owner" };
  // read before the pause is resolved: never this answer taken, whoever took the pause since
  if (error instanceof UninterpretableReplyError || error instanceof ReplyInterpreterMissingError)
    return { refused: "invalid-params", code: "a2a.reply-not-understood" };
  if (!isStillPending) return undefined; // the tree moved: the run's own failure is its task's
  if (error instanceof DtoValidationError)
    return { refused: "invalid-params", code: "a2a.decision-invalid" };
  return undefined;
}

/** A settled resume's outcome: accepted, refused, or — an unexpected failure, its pause still pending — `-32603`. */
export function settledOutcome(
  parts: A2AServerParts,
  key: A2ATaskKey,
  failure: { readonly error: unknown } | undefined,
  isStillPending: boolean,
): KeptReply {
  if (failure === undefined) return { accepted: true };
  const refused = refusedResume(failure.error, isStillPending);
  if (refused !== undefined) return refused;
  const name = failure.error instanceof Error ? failure.error.name : typeof failure.error;
  if (!isStillPending) {
    // its pause took the answer: what failed after is its task's status
    const text = `a resume of task ${key.taskId} failed (${name}) after it took its answer`;
    parts.log.warn("a2a.resume-failed-after-answer", text, logSubjectOf(key));
    return { accepted: true };
  }
  parts.log.error(
    "a2a.resume-failed",
    `a resume of task ${key.taskId} failed (${name}) before it took its answer`,
    logSubjectOf(key),
  );
  throw new A2AInternalError();
}
