import { PauseError } from "../core/error-families/pause-errors.js";
import { UnknownPauseError } from "../run/resume-agent.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { pauseAnswererOf, type PauseRecord } from "../infrastructure/pause-record.js";
import type { AnswerParts } from "./resume.js";
import type { ResumeOptions } from "./types.js";

/**
 * Who answers, as the pause's role says — checked; `undefined` for an unowned thread's owner.
 * An extension (#942) is checked the same way: who may answer may extend.
 */
export async function answeredByOf(
  parts: Pick<AnswerParts, "owned">,
  pause: PauseRecord,
  call: ResumeOptions,
): Promise<string | undefined> {
  const { ownerId, answeredBy } = call;
  if (pauseAnswererOf(pause) === PauseAnswerer.ThreadOwner) {
    if (answeredBy !== undefined) {
      throw new PauseError.PermissionDenied({
        message: `pause ${pause.pauseId} is answered by the thread's owner (${pause.channel}): pass ownerId, not answeredBy`,
      });
    }
    await parts.owned({ tenantId: pause.tenantId, threadId: pause.threadId, ownerId });
    return ownerId;
  }
  if (ownerId !== undefined) {
    throw new PauseError.PermissionDenied({
      message: `pause ${pause.pauseId} is answered through its channel (${pause.channel}): pass answeredBy, not ownerId`,
    });
  }
  if (typeof answeredBy !== "string" || answeredBy.trim() === "") {
    throw new PauseError.PermissionDenied({
      message: `pause ${pause.pauseId} is answered through its channel (${pause.channel}): answeredBy must name who answered`,
    });
  }
  return answeredBy;
}

/** The tenant's pause a resume answers; `UnknownPauseError` when the tenant has none of that id. */
export async function pauseOf(
  pauses: PausedExecutionRepository,
  request: { readonly pauseId: string },
  tenantId: string = DEFAULT_TENANT_ID,
): Promise<PauseRecord> {
  const pause = await pauses.findByTenantIdAndPauseId(tenantId, request.pauseId);
  if (pause === undefined) {
    throw new UnknownPauseError({ message: `tenant ${tenantId} has no pause ${request.pauseId}` });
  }
  return pause;
}
