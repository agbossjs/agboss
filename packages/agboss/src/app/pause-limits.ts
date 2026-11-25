import { PauseError } from "../core/error-families/pause-errors.js";
import type { PauseTarget } from "../flow/runtime/pause-channel.js";
import { instantAfter } from "../flow/runtime/pause-record-made.js";
import { pauseKeyOf, type PauseRecord } from "../infrastructure/pause-record.js";
import type { TimeSpan } from "../units/working-time.js";
import type { AppDeps } from "./app-deps.js";
import { calendarOfTarget, type CalendarParts } from "./pause-calendar.js";
import { ownDepsOf } from "./own-deps.js";

/**
 * The escalation limits of a pause (#1307): what its targets' `escalationLimits` allow, tightened
 * along its chain of custody — each target the pause waited under (the destination of a reassignment
 * too) adds its limits, and a limit is the smallest of them all, so moving a pause to a laxer target
 * never loosens what the first one set. The total wait counts from the pause's first asking (the
 * chain's first entry), never from a reassignment. The counts (`maxExtensions`, `maxReassignments`)
 * are read from the chain and checked by the store atomically with the write too.
 */

/** One limit on the total wait, with the target whose calendar counts it. */
interface TotalCap {
  readonly span: TimeSpan;
  readonly owner: PauseTarget;
}

/** What a pause's targets allow together. */
export interface ChainLimits {
  readonly maxExtensions?: number;
  readonly maxReassignments?: number;
  readonly totals: readonly TotalCap[];
}

/** The target of that name in the pause's workflow now; `undefined`: a deploy removed it. */
function targetNamed(deps: AppDeps, pause: PauseRecord, name: string): PauseTarget | undefined {
  try {
    return ownDepsOf(deps, pause.workflow).targetOf?.(name);
  } catch {
    return undefined;
  }
}

const smallest = (values: readonly (number | undefined)[]): number | undefined => {
  const given = values.filter((value): value is number => value !== undefined);
  return given.length === 0 ? undefined : Math.min(...given);
};

/** The limits of the targets `pause` waited under, and of `more` (the destination of a change). */
export function chainLimitsOf(
  deps: AppDeps,
  pause: PauseRecord,
  more: readonly PauseTarget[] = [],
): ChainLimits {
  const names = new Set([pause.target, ...pause.trail.map((entry) => entry.target)]);
  const known = [...names].flatMap((name) => {
    const found = targetNamed(deps, pause, name);
    return found === undefined ? [] : [found];
  });
  const targets = [...new Set([...known, ...more])];
  const limits = targets.map((target) => target.escalationLimits);
  const maxExtensions = smallest(limits.map((one) => one?.maxExtensions));
  const maxReassignments = smallest(limits.map((one) => one?.maxReassignments));
  return {
    ...(maxExtensions === undefined ? {} : { maxExtensions }),
    ...(maxReassignments === undefined ? {} : { maxReassignments }),
    totals: targets.flatMap((owner) => {
      const span = owner.escalationLimits?.maxTotalTimeout;
      return span === undefined ? [] : [{ span, owner }];
    }),
  };
}

/** How many times the pause's deadline was changed: the `timeout-changed` entries of its chain. */
export const timeoutChangesOf = (pause: Pick<PauseRecord, "trail">): number =>
  pause.trail.filter((entry) => entry.action === "timeout-changed").length;

/** The pause's first asking: its `opened` entry. */
const firstAskedAtOf = (pause: PauseRecord): Date => new Date(pause.trail[0]?.at ?? pause.askedAt);

/**
 * The latest instant the pause may wait until (ISO 8601): the smallest of what each limit on the total
 * wait counts from its first asking, by the calendar of the target that set it; `undefined`: no limit.
 */
export async function maxExpiresAtOf(
  parts: CalendarParts,
  pause: PauseRecord,
  limits: ChainLimits,
  assignees: readonly string[] | undefined,
): Promise<string | undefined> {
  const from = firstAskedAtOf(pause);
  const instants = await Promise.all(
    limits.totals.map(async ({ span, owner }) =>
      (
        await instantAfter(span, from, calendarOfTarget(parts, pause, owner, assignees).add)
      ).toISOString(),
    ),
  );
  return instants.length === 0 ? undefined : instants.reduce((a, b) => (a < b ? a : b));
}

/** `PauseError.EscalationLimitExceeded`, naming the pause by its key and the limit by its name. */
export const limitExceeded = (
  pause: PauseRecord,
  limit: string,
): PauseError.EscalationLimitExceeded =>
  new PauseError.EscalationLimitExceeded({
    message: `pause ${pauseKeyOf(pause.tenantId, pause.pauseId)}: its ${limit} limit is reached`,
  });
