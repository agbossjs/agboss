import { PauseError } from "../core/error-families/pause-errors.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { pauseRespondentOf, pauseKeyOf, type PauseRecord } from "../infrastructure/pause-record.js";
import type { AnswerParts } from "./resume.js";
import type { ResumeOptions } from "./types.js";
import { PauseRespondent } from "../pause/respondent.js";

/**
 * Who answers, as the pause's role says — checked; `undefined` for an unowned thread's owner.
 * An extension (#942) and a reassignment (#946) are checked the same way: who may answer may act.
 * A message names the pause by its key, never its id (the id is the right to answer it).
 */
export async function actorOf(
  parts: Pick<AnswerParts, "owned">,
  pause: PauseRecord,
  call: ResumeOptions,
): Promise<PauseActor | undefined> {
  const { ownerId, actor } = call;
  const key = pauseKeyOf(pause.tenantId, pause.pauseId);
  if (pauseRespondentOf(pause) === PauseRespondent.Owner) {
    if (actor !== undefined) {
      throw new PauseError.PermissionDenied({
        message: `pause ${key} is answered by the thread's owner (${pause.target}): pass ownerId, not actor`,
      });
    }
    await parts.owned({ tenantId: pause.tenantId, threadId: pause.threadId, ownerId });
    return ownerId === undefined ? undefined : { id: ownerId };
  }
  if (ownerId !== undefined) {
    throw new PauseError.PermissionDenied({
      message: `pause ${key} is answered through its channel (${pause.target}): pass actor, not ownerId`,
    });
  }
  if (typeof actor?.id !== "string" || actor.id.trim() === "") {
    throw new PauseError.PermissionDenied({
      message: `pause ${key} is answered through its channel (${pause.target}): actor.id must name who answered`,
    });
  }
  return actor;
}

/** The tenant's pause a resume answers; `PauseError.UnknownPause` when the tenant has none of that id. */
export async function pauseOf(
  pauses: PausedExecutionRepository,
  request: { readonly pauseId: string },
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<PauseRecord> {
  const pause = await pauses.findByTenantIdAndPauseId(tenantId, request.pauseId);
  if (pause === undefined) {
    throw new PauseError.UnknownPause({
      message: `tenant ${tenantId} has no pause ${request.pauseId}`,
    });
  }
  return pause;
}
