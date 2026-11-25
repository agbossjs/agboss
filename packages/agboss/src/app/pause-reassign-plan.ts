import { definedFields } from "../core/defined-fields.js";
import { PauseError } from "../core/error-families/pause-errors.js";
import { canTakePausesOf, pauseTargetOf } from "../channels/pause-targets.js";
import type { Class } from "../components/injection.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import { trailOf } from "../flow/runtime/pause-chain.js";
import type { PauseChannel, PauseTarget } from "../flow/runtime/pause-channel.js";
import { assignedBy } from "../flow/runtime/pause-hooks.js";
import { chosenChannel } from "../flow/runtime/pause-open.js";
import { newPauseId, pauseKeyOf, type PauseRecord } from "../infrastructure/pause-record.js";
import type {
  PauseDeadlineSet,
  PauseInPlaceReassignment,
  PauseReassignmentChange,
  PauseReplacement,
  PauseSeen,
} from "../infrastructure/pause-notices.js";
import type { TimeSpan } from "../units/working-time.js";
import type { AppDeps } from "./app-deps.js";
import { type CalendarParts } from "./pause-calendar.js";
import {
  chainLimitsOf,
  limitExceeded,
  timeoutChangesOf,
  type ChainLimits,
} from "./pause-limits.js";
import { deadlineAfter } from "./pause-reassign-deadline.js";
import { ownDepsOf } from "./own-deps.js";
import { reassignmentsOf } from "../infrastructure/pause-reassign-transition.js";

/**
 * What a reassignment comes to (#946, #1307d): where the pause waits after it — the same target and
 * channel (changed in place) or another (a replacement) —, who it is for, how long it waits, and the
 * change the store applies atomically. Built the same for an operator's `app.reassignPause` and an
 * expiry's `PauseExpiration.reassign`, so the rules (kind and DTO of the target, the destination's
 * calendar, the chain's limits) are one.
 */

/** What a reassignment asks, whoever asks it. */
export interface ReassignFacts {
  readonly target?: Class | undefined;
  readonly channel?: Class | undefined;
  readonly assignees?: readonly string[] | undefined;
  readonly timeout?: TimeSpan | undefined;
  /** Already masked by the pause's workflow's PII policy. */
  readonly reason?: string | undefined;
  readonly actor?: PauseActor | undefined;
  /** An expiry's: applied only while the deadline is due, and always sets a new deadline. */
  readonly isExpiry: boolean;
}

/** Where the pause waits after the reassignment, as the permission hook and the notices read it. */
export interface ReassignDestination {
  readonly target: PauseTarget;
  readonly channel: PauseChannel | undefined;
  readonly assignees: readonly string[] | undefined;
  readonly isInPlace: boolean;
  /** What the change sets of the deadline; `undefined`: the pause keeps its own. */
  readonly deadline: PauseDeadlineSet | undefined;
}

/** What the store is given, and what the caller says of the pause afterwards. */
export interface ReassignPlan extends ReassignDestination {
  readonly change: PauseReassignmentChange;
}

const incompatible = (pause: PauseRecord, what: string): PauseError.IncompatibleTarget =>
  new PauseError.IncompatibleTarget({
    message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: ${what}`,
  });

/** The pause target of this workflow the request names (`undefined`: the pause's own), checked to take the pause. */
function destinationTarget(
  deps: AppDeps,
  pause: PauseRecord,
  from: PauseTarget,
  asked: Class | undefined,
): PauseTarget {
  if (asked === undefined || asked === from.cls) return from;
  const own = ownDepsOf(deps, pause.workflow);
  const found = (own.targets ?? []).find((target) => target.cls === asked);
  // only a target the source declares in `escalatesTo` may take its pauses
  if (found === undefined || !(from.escalatesTo ?? []).includes(found.name))
    throw incompatible(pause, "the target is not one this pause's target escalates to");
  const before = pauseTargetOf(from.cls);
  const after = pauseTargetOf(found.cls);
  if (before === undefined || after === undefined || !canTakePausesOf(before, after))
    throw incompatible(pause, "the target is of another kind or takes other DTOs");
  return found;
}

/** Who the pause is for after it: the request's list, the destination's `assign`, or what it had. */
async function assigneesAfter(
  pause: PauseRecord,
  to: PauseTarget,
  isSameTarget: boolean,
  asked: readonly string[] | undefined,
): Promise<readonly string[] | undefined> {
  if (asked !== undefined) return asked.length === 0 ? undefined : asked;
  if (to.assign !== undefined)
    return assignedBy(to, {
      input: pause.input,
      toolCall: pause.toolCall,
      trail: trailOf(pause),
    });
  return isSameTarget ? pause.assignees : undefined;
}

/** The pause's own channel as its target has it now; `PauseError.IncompatibleTarget` when a deploy removed it. */
function ownChannelOf(pause: PauseRecord, target: PauseTarget): PauseChannel | undefined {
  if (pause.channel === undefined) return undefined;
  const found = target.channels.get(pause.channel);
  if (found === undefined)
    throw incompatible(pause, "its channel is no longer in this application");
  return found;
}

/**
 * The channel a moved pause is asked on: the one the call names (it must serve the destination), else
 * the destination's only one or its selector's pick (none for an owner's target nobody serves).
 */
async function channelAfter(
  pause: PauseRecord,
  from: PauseTarget,
  to: PauseTarget,
  ask: ReassignFacts,
  opening: {
    readonly assignees: readonly string[] | undefined;
    readonly expiresAt?: string | undefined;
  },
): Promise<PauseChannel | undefined> {
  const { channel } = ask;
  if (channel !== undefined) {
    const named = [...to.channels.values()].find((one) => one.cls === channel);
    if (named === undefined) throw incompatible(pause, "the channel does not serve the target");
    return named;
  }
  // a pause that stays under its target stays on its channel
  if (to === from) return ownChannelOf(pause, from);
  return chosenChannel(
    to,
    { input: pause.input, toolCall: pause.toolCall },
    {
      ...(opening.assignees === undefined ? {} : { assignees: opening.assignees }),
      ...(opening.expiresAt === undefined ? {} : { expiresAt: new Date(opening.expiresAt) }),
      trail: pause.trail,
    },
  );
}

/** A call that sets only a deadline on the pause's own target: that is an extension, not a reassignment. */
const isTimeoutOnly = (ask: ReassignFacts, isSameTarget: boolean): boolean =>
  ask.timeout !== undefined &&
  isSameTarget &&
  !ask.isExpiry &&
  ask.assignees === undefined &&
  ask.channel === undefined;

/** The fields every change carries: who for, who did it, why, and the chain's reassignment limit. */
const commonOf = (plan: Omit<ReassignPlan, "change">, ask: ReassignFacts, limits: ChainLimits) =>
  definedFields({
    assignees: plan.assignees,
    actor: ask.actor,
    reason: ask.reason,
    maxReassignments: limits.maxReassignments,
  });

/** The deadline a change sets: an expiry's under the due guard (even when it sets none), an operator's open-guarded. */
function deadlineOfChange(plan: Omit<ReassignPlan, "change">, ask: ReassignFacts) {
  if (ask.isExpiry) return { due: plan.deadline ?? {} };
  return plan.deadline === undefined ? {} : { timeout: plan.deadline };
}

/** What the plan was made against: the store applies it only while the pause is still this (#1307). */
const seenOf = (pause: PauseRecord): PauseSeen => ({
  trailLength: pause.trail.length,
  isSent: pause.isSent,
  ...definedFields({ assignees: pause.assignees, expiresAt: pause.expiresAt }),
});

/** The change the store applies for a plan. */
function changeOf(
  plan: Omit<ReassignPlan, "change">,
  ask: ReassignFacts,
  limits: ChainLimits,
  pause: PauseRecord,
): PauseReassignmentChange & { readonly seen: PauseSeen } {
  const counts = ask.timeout !== undefined && !ask.isExpiry;
  const common = {
    seen: seenOf(pause),
    ...commonOf(plan, ask, limits),
    ...deadlineOfChange(plan, ask),
    ...(counts ? { countsAsExtension: true as const } : {}),
    ...definedFields({ maxExtensions: counts ? limits.maxExtensions : undefined }),
  };
  if (plan.isInPlace) return common satisfies PauseInPlaceReassignment;
  const to = {
    target: plan.target.name,
    respondent: plan.target.respondent,
    ...definedFields({ channel: plan.channel?.name }),
  };
  return { pauseId: newPauseId(), ...common, to } satisfies PauseReplacement;
}

/** The chain's reassignment limit, and its extension limit for a call that sets a deadline, not yet reached. */
function assertWithinLimits(pause: PauseRecord, ask: ReassignFacts, limits: ChainLimits): void {
  const { maxReassignments, maxExtensions } = limits;
  if (maxReassignments !== undefined && reassignmentsOf(pause) >= maxReassignments)
    throw limitExceeded(pause, "maxReassignments");
  const isExtension = ask.timeout !== undefined && !ask.isExpiry;
  if (isExtension && maxExtensions !== undefined && timeoutChangesOf(pause) >= maxExtensions)
    throw limitExceeded(pause, "maxExtensions");
}

/** What the call comes to for `pause` (whose own target is `from`), or the error that refuses it. */
export async function planOf(
  parts: CalendarParts,
  pause: PauseRecord,
  from: PauseTarget,
  ask: ReassignFacts,
): Promise<ReassignPlan> {
  const to = destinationTarget(parts.deps, pause, from, ask.target);
  const limits = chainLimitsOf(parts.deps, pause, [to]);
  assertWithinLimits(pause, ask, limits);
  if (isTimeoutOnly(ask, to === from))
    throw new PauseError.InvalidTimeout({
      message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: a deadline alone is extendPause's change, not a reassignment's`,
    });
  const assignees = await assigneesAfter(pause, to, to === from, ask.assignees);
  const askedChannel = [...to.channels.values()].find((one) => one.cls === ask.channel);
  const isInPlace =
    to === from && (ask.channel === undefined || askedChannel?.name === pause.channel);
  const deadline = await deadlineAfter(parts, pause, { from, to }, assignees, ask, limits);
  const channel = await channelAfter(pause, from, to, ask, {
    assignees,
    expiresAt: deadline?.expiresAt ?? pause.expiresAt,
  });
  const plan = { target: to, channel, assignees, isInPlace, deadline };
  return { ...plan, change: changeOf(plan, ask, limits, pause) };
}
