import type { AnswerPermitCall, PermitAnswer } from "../channels/pause-contexts.js";
import type { PauseChannel } from "../flow/runtime/pause.js";
import { isApprovalPause, type PauseRecord } from "../infrastructure/pause-record.js";
import { PauseAnswererError } from "../run/resume-agent.js";
import type { AnswerParts } from "./resume.js";
import { ownDepsOf } from "./own-deps.js";
import type { AppDeps } from "./app-deps.js";

/**
 * A target's `permitAnswer` (#1307c): called by the resume once the answer is read and validated and
 * before anything is recorded or moved. Fail closed: only `true` lets the answer through — `false`,
 * a throw, a rejection and any other value refuse it with `PauseAnswererError`, and the pause stays
 * as it was. The message names the pause, never the hook's text.
 */

/** The pause's channel as its workflow has it now; `undefined` when a deploy removed it. */
export function channelOfPause(deps: AppDeps, pause: PauseRecord): PauseChannel | undefined {
  try {
    return ownDepsOf(deps, pause.workflow).channelOf?.(pause.channel);
  } catch {
    // a channel this workflow no longer has: no hook to call (the resume's version check came first)
    return undefined;
  }
}

/** A pause's `permitAnswer` as its workflow has it now; `undefined`: none. */
export const permitsOf =
  (deps: AppDeps) =>
  (pause: PauseRecord): PermitAnswer | undefined =>
    channelOfPause(deps, pause)?.permitAnswer;

/** What `permitAnswer` reads for this pause, answered by `answeredBy` with `output`. */
function permitCallOf(
  pause: PauseRecord,
  answeredBy: string | undefined,
  output: unknown,
): AnswerPermitCall {
  const actor = answeredBy === undefined ? {} : { actor: { id: answeredBy } };
  const assignees = pause.assignee === undefined ? {} : { assignees: [pause.assignee] };
  if (!isApprovalPause(pause))
    return { ...actor, ...assignees, input: pause.ask, output, trail: [] };
  const { callId, tool, summary } = pause.ask;
  return {
    ...actor,
    ...assignees,
    input: pause.ask.arguments,
    output,
    toolCall: { callId, tool, summary },
    trail: [],
  };
}

/** Throws `PauseAnswererError` unless the pause's target permits this answer (or has no `permitAnswer`). */
export async function assertAnswerPermitted(
  parts: Pick<AnswerParts, "permits">,
  pause: PauseRecord,
  answeredBy: string | undefined,
  output: unknown,
): Promise<void> {
  const permit = parts.permits?.(pause);
  if (permit === undefined) return;
  let verdict: unknown;
  try {
    verdict = await permit(permitCallOf(pause, answeredBy, output));
  } catch (cause) {
    throw new PauseAnswererError({
      message: `pause ${pause.pauseId}: its target's permitAnswer failed, the answer is refused`,
      cause,
    });
  }
  if (verdict !== true)
    throw new PauseAnswererError({
      message: `pause ${pause.pauseId}: its target's permitAnswer refused the answer`,
    });
}
