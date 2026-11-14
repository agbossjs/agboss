import { isExpiresIn } from "../channels/channel-rules.js";
import { checkedCallers } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { remindAtOf } from "../flow/runtime/pause-record-made.js";
import { DtoValidationError, type DtoIssue } from "../dto/errors.js";
import type { Clock } from "../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { pauseKeyOf, PauseStatus, type PauseRecord } from "../infrastructure/pause-record.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import type { Milliseconds } from "../units/index.js";
import type { AppDeps } from "./app-deps.js";
import { ownDepsOf } from "./own-deps.js";
import type { AnswerParts } from "./resume.js";
import { answeredByOf, pauseOf } from "./resume.js";
import { pauseClosed } from "./pause-closed.js";
import type { App, ExtendPauseRequest, PauseCallerOptions } from "./types.js";

/**
 * `app.extendPause` (#942, Q7): an operator moves an open pause's deadline later. Who may: as an
 * answer (`answeredBy` for a channel's pause, the thread's `ownerId` for its owner's). The new
 * deadline is `now + expiresIn`; refused when it is not later than the current one, when the pause
 * has no deadline (none is ever added), or when it is past the deadline the pause was made under —
 * its run's, or a quorum's (`boundAt`); exactly that deadline is allowed. A closed pause, or one
 * past its deadline, is `PauseClosedError`. The store applies it atomically (`extend…`, its
 * compare-and-set on `expiresAt > at` against the expiry look: one wins); the channel and the
 * listeners are told `extended` in the same transaction. No lease is taken and no tree moves.
 */

/** What an extension needs from the workflow's app. */
export interface ExtendParts extends Pick<AnswerParts, "owned"> {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  /** Throws `ApplicationStoppingError` once `app.close()` began. */
  readonly accepting: () => void;
  /** The workflow's deps: its channels (their `remindBefore`) and who hears of the extension (#940). */
  readonly deps: AppDeps;
}

/** How long before its deadline the pause's channel reminds (#942); `undefined`: never (or its channel is gone). */
function remindBeforeOf(deps: AppDeps, pause: PauseRecord): Milliseconds | undefined {
  try {
    return ownDepsOf(deps, pause.workflow).channelOf?.(pause.channel).remindBefore;
  } catch {
    // a channel this workflow no longer has: nobody to remind
    return undefined;
  }
}

function reject(issues: readonly DtoIssue[]): never {
  throw new DtoValidationError({ dto: "ExtendPauseRequest", issues });
}

/** The request as an untyped (JS) caller may pass it, checked: a pause id and a duration. */
function checked(request: unknown): ExtendPauseRequest {
  const pauseId: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, "pauseId") : undefined;
  const expiresIn: unknown =
    typeof request === "object" && request !== null ? Reflect.get(request, "expiresIn") : undefined;
  if (typeof pauseId !== "string" || pauseId === "")
    reject([{ path: ".pauseId", reason: "a pause's id is a non-empty text" }]);
  if (!isExpiresIn(expiresIn))
    reject([
      {
        path: ".expiresIn",
        reason: `${String(expiresIn)} is no duration — a positive finite one of at least seconds(1), like hours(24)`,
      },
    ]);
  return { pauseId, expiresIn };
}

/** The deadline an extension of `pause` to `expiresAt` moves from; refused when it may not move there. */
function previousDeadlineOf(pause: PauseRecord, expiresAt: string): string {
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

/** The pause open and not yet past its deadline, or why it is not. */
async function assertOpen(parts: ExtendParts, pause: PauseRecord): Promise<void> {
  const isDue = pause.expiresAt !== undefined && pause.expiresAt <= parts.clock.now().toISOString();
  if (pause.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
}

/** `app.extendPause` of one workflow's app. */
export const extendPauseOf =
  (parts: ExtendParts): App["extendPause"] =>
  async (given, call: PauseCallerOptions = {}) => {
    parts.accepting();
    const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
    checkedCallers("PauseCallerOptions", { ...call, tenantId });
    const request = checked(given);
    const pause = await pauseOf(parts.pauses, request, tenantId);
    await answeredByOf(parts, pause, call);
    await assertOpen(parts, pause);
    const now = parts.clock.now();
    const expiresAt = new Date(now.getTime() + request.expiresIn).toISOString();
    const previousExpiresAt = previousDeadlineOf(pause, expiresAt);
    const remindAt = remindAtOf(expiresAt, remindBeforeOf(parts.deps, pause), now);
    const extended = await parts.pauses.extendByTenantIdAndPauseId(
      tenantId,
      pause.pauseId,
      { expiresAt, ...(remindAt === undefined ? {} : { remindAt }) },
      now,
      recipientsIn(parts.deps.pause, pause),
    );
    // the expiry, an answer or a cancel won the compare-and-set: refused, with why
    if (extended === undefined) throw await pauseClosed(parts.pauses, pause, parts.clock.now());
    noticesWritten(parts.deps.pause);
    return { pauseKey: pauseKeyOf(tenantId, pause.pauseId), expiresAt, previousExpiresAt };
  };
