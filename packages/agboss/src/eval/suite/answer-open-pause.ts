import type { App, ExecutionOutput } from "../../app/types.js";
import { nameOf } from "../../components/name-of.js";
import type { EvalPauseScript } from "./pauses.js";

/**
 * Answers the open pause of a scripted answer's target (#1328d): the one place that finds the
 * pending entry of the target's channel on a paused execution and resumes it by decision or reply,
 * for the actor given — shared one to one by `@agboss/core/eval` (`answerPause` in a case) and
 * `@agboss/core/testing` (`answerPause` of a test's fixtures).
 */

/** A scripted answer with no pause of its target to take it: the script is wrong, not the run. */
export class PauseNotOpenError extends Error {
  override readonly name = "PauseNotOpenError";
}

/** The pause of `script.target` that `paused` waits on, answered; the output of the resume. */
export async function answerOpenPause(
  app: Pick<App, "resume">,
  paused: ExecutionOutput,
  script: EvalPauseScript,
): Promise<ExecutionOutput> {
  const channel = nameOf(script.target);
  const pending = paused.pending.find((found) => found.channel === channel);
  if (pending?.pauseId === undefined)
    throw new PauseNotOpenError(
      `no open pause of ${channel} to answer: ${
        paused.pending.map((found) => found.channel).join(", ") || "none is pending"
      }`,
    );
  const caller = { tenantId: paused.tenantId, ownerId: script.actor?.id };
  const { pauseId } = pending;
  return script.reply === undefined
    ? app.resume({ pauseId, decision: script.decision }, caller)
    : app.resume({ pauseId, reply: script.reply }, caller);
}
