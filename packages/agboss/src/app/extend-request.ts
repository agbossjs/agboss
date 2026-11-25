import { isPauseTimeout } from "../channels/channel-rules.js";
import type { PauseTarget } from "../flow/runtime/pause.js";
import { isWorkingDuration } from "../units/index.js";
import { spanText } from "../units/working-time.js";
import { type DtoIssue, invalidDto } from "../dto/errors.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { ExtendPauseRequest } from "./extend-types.js";

/** The checks of an extension's request and of the deadline it moves to (#942, #944): split from `pause-extension.ts`. */

export function reject(issues: readonly DtoIssue[]): never {
  throw invalidDto({ dto: "ExtendPauseRequest", issues });
}

/** The request as an untyped (JS) caller may pass it, checked: a pause id and a duration. */
export function checked(request: unknown): ExtendPauseRequest {
  const pauseId: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, "pauseId") : undefined;
  const expiresIn: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, "expiresIn") : undefined;
  if (typeof pauseId !== "string" || pauseId === "")
    reject([{ path: ".pauseId", reason: "a pause's id is a non-empty text" }]);
  if (!isPauseTimeout(expiresIn))
    reject([
      {
        path: ".expiresIn",
        reason: `${spanText(expiresIn)} is no duration — a positive finite one of at least seconds(1) and at most 5 years, like hours(24) or workingHours(8)`,
      },
    ]);
  return { pauseId, expiresIn };
}

/** The deadline an extension of `pause` to `expiresAt` moves from; refused when it may not move there. */
export function previousDeadlineOf(pause: PauseRecord, expiresAt: string): string {
  const { expiresAt: current, boundAt } = pause;
  if (current === undefined)
    return reject([{ path: ".pauseId", reason: "the pause has no deadline: none is added to it" }]);
  if (expiresAt <= current)
    return reject([
      {
        path: ".expiresIn",
        reason: `the new deadline ${expiresAt} is not later than the current one, ${current}`,
      },
    ]);
  if (boundAt !== undefined && expiresAt > boundAt)
    return reject([
      {
        path: ".expiresIn",
        reason: `the new deadline ${expiresAt} is past the deadline the pause is bound by, ${boundAt}`,
      },
    ]);
  return current;
}

/**
 * A plain `expiresIn` for a pause whose role reminds in working time is refused (#944): a calendar
 * cannot subtract — the run-time twin of `[pause.remind-before-working-without-working-timeout]`.
 */
export function assertSameKind(request: ExtendPauseRequest, target: PauseTarget | undefined): void {
  if (isWorkingDuration(target?.remindBefore) && !isWorkingDuration(request.expiresIn))
    reject([
      {
        path: ".expiresIn",
        reason: "this target reminds in working time: extend it with workingHours / workingMinutes",
      },
    ]);
}
