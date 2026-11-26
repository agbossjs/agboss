import { PauseError } from "../core/error-families/pause-errors.js";
import { checkedCallers } from "../flow/context/context-values.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { instantAfter, reminderOf } from "../flow/runtime/pause-record-made.js";
import { checkedTimeout } from "../flow/runtime/pause-hooks.js";
import type { PauseTarget } from "../flow/runtime/pause.js";
import type { Clock } from "../infrastructure/clock.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { isAsSeen, seenOf } from "../infrastructure/pause-seen.js";
import type { PauseSeen } from "../infrastructure/pause-notices.js";
import { pauseKeyOf, PauseStatus, type PauseRecord } from "../infrastructure/pause-record.js";
import { noticesWritten, recipientsIn } from "../pause/index.js";
import { pauseTallyOf } from "../pause/pause-tally.js";
import { Timeout } from "../units/index.js";
import { definedFields } from "../core/defined-fields.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import { assertTimeoutChangePermitted, targetOfPause } from "./answer-permit.js";
import type { AppDeps } from "./app-deps.js";
import { calendarOfTarget } from "./pause-calendar.js";
import { toldTimeoutChanged } from "./pause-change-events.js";
import { pauseClosed } from "./pause-closed.js";
import {
  chainLimitsOf,
  limitExceeded,
  maxExpiresAtOf,
  timeoutChangesOf,
  type ChainLimits,
} from "./pause-limits.js";
import { assertNotInFirstSend, maskedReason } from "./pause-reassign-support.js";
import type { AnswerParts } from "./resume.js";
import { actorOf, pauseOf } from "./resume.js";
import { checked } from "./timeout-request.js";
import type { PauseTimeoutChangeResult, SetPauseTimeoutRequest } from "./timeout-types.js";
import type { AnyTenantApp, PauseCallerOptions } from "./types.js";

/**
 * `app.setPauseTimeout` (#1307, #942): an operator moves an open pause's deadline — later or earlier
 * — sets one, or takes it away (`Timeout.None`). Who may: as an answer (`actor` for a channel's
 * pause, the thread's `ownerId` for its owner's), and the target's `permitTimeoutChange` when it
 * has one (fail closed: only `true` permits, `PauseError.PermissionDenied` otherwise). The new
 * deadline is `now + timeout` (by the target's calendar for working time) — at least `seconds(1)`
 * from now, so never in the past; refused when it is past the deadline the pause was made under
 * (its run's, or a quorum's: `boundAt`; exactly that deadline is allowed) or the chain's
 * `escalationLimits` (`maxTotalTimeout`, `maxExtensions`: `PauseError.EscalationLimitExceeded`). A
 * closed pause, or one past its deadline, is `PauseError.Closed` — judged at the instant of the
 * write: a calendar that took seconds does not keep a deadline that passed meanwhile open (#1148). A
 * pause whose first send is still in flight is `PauseError.UpdateContended`: its channel would hear
 * of the change before it heard of the pause. The store applies the change atomically (its
 * compare-and-set over the deadline this call read, while the pause is open — the expiry look, an
 * answer and another change: one wins); the channel and the listeners are told `timeout-changed` in
 * the same transaction, once, by the winner. A call that loses the compare-and-set
 * `MAX_TIMEOUT_ATTEMPTS` (8) times in a row is `PauseError.UpdateContended` (`pause.update-contended`);
 * it changed nothing, retrying is safe. No lease is taken and no tree moves.
 */

/** What a timeout change needs from the workflow's app. */
export interface TimeoutParts extends Pick<AnswerParts, "owned"> {
  readonly pauses: PausedExecutionRepository;
  readonly clock: Clock;
  /** Throws `ApplicationStoppingError` once `app.close()` began. */
  readonly accepting: () => void;
  /** The workflow's deps: its targets (their calendar, `remindBefore`, limits and permit) and who hears of the change (#940). */
  readonly deps: AppDeps;
}

/** The pause open and not yet past its deadline, or why it is not. */
async function assertOpen(parts: TimeoutParts, pause: PauseRecord): Promise<void> {
  const isDue = pause.expiresAt !== undefined && pause.expiresAt <= parts.clock.now().toISOString();
  if (pause.status !== PauseStatus.Pending || isDue)
    throw await pauseClosed(parts.pauses, pause, parts.clock.now());
}

/** The pause's target as its workflow has it now; `undefined`: it is gone (the permit then refuses). */
function targetOf(deps: AppDeps, pause: PauseRecord): PauseTarget | undefined {
  try {
    return targetOfPause(deps, pause);
  } catch {
    return undefined;
  }
}

/**
 * How many times a timeout change reads and tries before it gives up with `PauseError.UpdateContended`.
 * A lost compare-and-set means another writer changed the deadline in the same instant; each retry
 * re-reads, so losing again needs yet another writer to win in between. Eight lost rounds in a row
 * is a hot pause, not a normal race (a handful of operators clicking together settle in two or three),
 * and an unbounded loop would hold the caller; a typed error lets it decide.
 */
export const MAX_TIMEOUT_ATTEMPTS = 8;

/**
 * `app.setPauseTimeout` of one workflow's app. The store's compare-and-set decides: the write applies
 * only over the deadline this call read. A call that lost re-reads the pause and decides again —
 * refused when it is closed, tried again over the new deadline otherwise. `timeout-changed` is told
 * only for a write that won, and `previousExpiresAt` is the deadline that write replaced (#1099).
 */
export const setPauseTimeoutOf =
  (parts: TimeoutParts): AnyTenantApp["setPauseTimeout"] =>
  async (given, call: PauseCallerOptions = {}) => {
    parts.accepting();
    const tenantId = call.tenantId ?? DEFAULT_TENANT_ID;
    checkedCallers("PauseCallerOptions", { ...call, tenantId });
    const request = checked(given);
    let pause = await pauseOf(parts.pauses, request, tenantId);
    const actor = await actorOf(parts, pause, call);
    // what the hook already said yes to: asked again only when the pause is no longer that
    const permitted: { seen?: PauseSeen } = {};
    for (let attempt = 1; attempt <= MAX_TIMEOUT_ATTEMPTS; attempt += 1) {
      const changed = await changedOnce(parts, { pause, request, tenantId, actor, permitted });
      if (changed !== undefined) return changed;
      // lost the compare-and-set: the expiry, an answer, a cancel or another change won — read what it left
      pause = await pauseOf(parts.pauses, request, tenantId);
    }
    throw new PauseError.UpdateContended({
      pauseKey: pauseKeyOf(tenantId, request.pauseId),
      attempts: MAX_TIMEOUT_ATTEMPTS,
    });
  };

/**
 * The chain's limits the change to `expiresAt` (absent: no deadline) must keep, or the error that
 * refuses it: the count of changes, the total wait counted from the first asking, and the deadline
 * of the run or quorum the pause was made under. A ceiling already behind `now` refuses every
 * deadline, as it is below any that is after `now`.
 */
async function assertWithinLimits(
  parts: TimeoutParts,
  pause: PauseRecord,
  expiresAt: string | undefined,
): Promise<ChainLimits> {
  const limits = chainLimitsOf(parts.deps, pause);
  if (limits.maxExtensions !== undefined && timeoutChangesOf(pause) >= limits.maxExtensions)
    throw limitExceeded(pause, "maxExtensions");
  const cap = await maxExpiresAtOf(parts, pause, limits, pause.assignees);
  if (cap !== undefined && (expiresAt === undefined || expiresAt > cap))
    throw limitExceeded(pause, "maxTotalTimeout");
  const { boundAt } = pause;
  if (boundAt !== undefined && (expiresAt === undefined || expiresAt > boundAt))
    throw limitExceeded(pause, "run or quorum deadline");
  return limits;
}

/** The deadline a timeout change sets and the reminder before it (each absent: none), and the chain's limits it keeps. */
async function deadlineAfter(
  parts: TimeoutParts,
  pause: PauseRecord,
  target: PauseTarget,
  timeout: SetPauseTimeoutRequest["timeout"],
): Promise<{ expiresAt?: string; remindAt?: string; limits: ChainLimits }> {
  const now = parts.clock.now();
  const { add, remind } = calendarOfTarget(parts, pause, target, pause.assignees);
  const span = timeout === Timeout.None ? undefined : checkedTimeout(target, timeout);
  const expiresAt =
    span === undefined ? undefined : (await instantAfter(span, now, add)).toISOString();
  const limits = await assertWithinLimits(parts, pause, expiresAt);
  const remindAt = await reminderOf(
    now,
    { expiresAt, expiresIn: span },
    target.remindBefore,
    add,
    remind,
  );
  return { ...definedFields({ expiresAt, remindAt }), limits };
}

/** One try of a change over the pause as it was read; `undefined`: the compare-and-set was lost. */
async function changedOnce(
  parts: TimeoutParts,
  call: {
    readonly pause: PauseRecord;
    readonly request: SetPauseTimeoutRequest;
    readonly tenantId: string;
    readonly actor: PauseActor | undefined;
    readonly permitted: { seen?: PauseSeen };
  },
): Promise<PauseTimeoutChangeResult | undefined> {
  const { pause, request, tenantId, actor, permitted } = call;
  await assertOpen(parts, pause);
  const known = targetOf(parts.deps, pause);
  if (known !== undefined) assertNotInFirstSend(pause, known);
  const ask = { actor, timeout: request.timeout, reason: request.reason };
  // a retry over the pause as the hook last saw it needs no second answer (a hook may have effects)
  if (permitted.seen === undefined || !isAsSeen(pause, permitted.seen)) {
    await assertTimeoutChangePermitted(parts.deps, pause, ask);
    permitted.seen = seenOf(pause);
  }
  // permitted: the target resolves
  const { expiresAt, remindAt, limits } = await deadlineAfter(
    parts,
    pause,
    targetOfPause(parts.deps, pause),
    request.timeout,
  );
  const reason = await maskedReason(parts.deps, pause, request.reason);
  // the calendar took time: whether the pause is still open is decided at this instant, not at
  // the call's start (#1148); the deadline itself keeps counting from `now`
  const at = parts.clock.now();
  await assertOpen(parts, pause);
  // a calendar slower than the timeout: no other writer is to blame, and asking again would not help
  if (expiresAt !== undefined && expiresAt <= at.toISOString())
    throw new PauseError.WorkingCalendar({
      message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: the deadline passed while the calendar was asked; use a longer timeout`,
    });
  const changed = await parts.pauses.changeTimeoutByTenantIdAndPauseId(
    tenantId,
    pause.pauseId,
    {
      seen: seenOf(pause),
      ...definedFields({
        expiresAt,
        previousExpiresAt: pause.expiresAt,
        remindAt,
        actor,
        reason,
        maxExtensions: limits.maxExtensions,
      }),
    },
    at,
    recipientsIn(parts.deps.pause, pause),
  );
  if (changed === undefined) return undefined;
  noticesWritten(parts.deps.pause);
  pauseTallyOf(parts.deps.pause)?.timeoutChanged(changed);
  await toldTimeoutChanged(parts.deps, pause, { previousExpiresAt: pause.expiresAt, expiresAt });
  return {
    ...(expiresAt === undefined ? {} : { expiresAt: new Date(expiresAt) }),
    ...(pause.expiresAt === undefined ? {} : { previousExpiresAt: new Date(pause.expiresAt) }),
  };
}
