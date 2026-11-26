import { PauseError } from "../core/error-families/pause-errors.js";
import { isPauseTimeout } from "../channels/channel-rules.js";
import { definedFields } from "../core/defined-fields.js";
import { invalidDto } from "../dto/errors.js";
import { Timeout } from "../units/index.js";
import { spanText } from "../units/working-time.js";
import { MAX_REASON } from "./reassign-request.js";
import type { SetPauseTimeoutRequest } from "./timeout-types.js";

/** The checks of a timeout change's request (#1307): split from `pause-timeout.ts`. */

const readOf = (request: unknown, field: string): unknown =>
  typeof request === "object" && request !== null ? Reflect.get(request, field) : undefined;

/** The request's `timeout`: a duration of at least `seconds(1)` or `Timeout.None`; anything else is `PauseError.InvalidTimeout`. */
function timeoutOf(request: unknown): SetPauseTimeoutRequest["timeout"] {
  const timeout = readOf(request, "timeout");
  if (timeout === Timeout.None || isPauseTimeout(timeout)) return timeout;
  throw new PauseError.InvalidTimeout({
    message: `${spanText(timeout)} is no timeout — a finite duration of at least seconds(1) and at most 5 years, like hours(24) or workHours(8), or Timeout.None`,
  });
}

/** The request as an untyped (JS) caller may pass it, checked: a pause id, a timeout, a reason. */
export function checked(request: unknown): SetPauseTimeoutRequest {
  const pauseId = readOf(request, "pauseId");
  if (typeof pauseId !== "string" || pauseId === "")
    throw invalidDto({
      dto: "SetPauseTimeoutRequest",
      issues: [{ path: ".pauseId", reason: "a pause's id is a non-empty text" }],
    });
  const reason = readOf(request, "reason");
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.trim() === "" || reason.length > MAX_REASON)
  )
    throw invalidDto({
      dto: "SetPauseTimeoutRequest",
      issues: [
        {
          path: ".reason",
          reason: `a reason is a non-blank text of at most ${String(MAX_REASON)} characters`,
        },
      ],
    });
  return { pauseId, timeout: timeoutOf(request), ...definedFields({ reason }) };
}
