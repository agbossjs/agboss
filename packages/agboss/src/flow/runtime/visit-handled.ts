import type { UsageRecord } from "../../finops/usage.js";
import type { Clock } from "../../infrastructure/clock.js";
import {
  compensationsOfHeldVisit,
  compensationsOfVisit,
  mergeCompensations,
  type CompensationEntry,
} from "../compensation.js";
import { heldEntriesUndone, withHeldUndone } from "./compensation/held-on-error.js";
import type { StepErrorSite } from "./compensation/step-error-undo.js";
import type { ExecutionStateType, ExecutionStateUpdate } from "./state.js";
import type { VisitDeps } from "./visit.js";

/** A failed visit's own entries: a held-back undo action's owed undo run (#675), else its close. */
function failedCompensations(
  site: Parameters<typeof compensationsOfVisit>[0],
  deps: VisitDeps,
  { isHeldBack, clock }: { readonly isHeldBack: boolean; readonly clock: Clock },
): ReturnType<typeof compensationsOfHeldVisit> {
  return isHeldBack
    ? compensationsOfHeldVisit({ ...site, clock, deps })
    : compensationsOfVisit(site);
}

/**
 * A handled failure's update with its entries — a failed child's undone ones first (#340), the
 * visit's own after them — and the owed undo's spend after the visit's own (#675).
 */
function withOwnCompensations(
  handled: ExecutionStateUpdate,
  childEntries: readonly CompensationEntry[],
  own: {
    readonly compensations?: readonly CompensationEntry[] | undefined;
    readonly usage: readonly UsageRecord[];
  },
): ExecutionStateUpdate {
  const compensations = [...childEntries, ...(own.compensations ?? [])];
  const visitUsage = Array.isArray(handled.usage) ? handled.usage : [];
  const usage = [...visitUsage, ...own.usage];
  return { ...handled, usage, ...(compensations.length === 0 ? {} : { compensations }) };
}

/** What a handled failure's visit adds: the held children's undo (#1281), its own entries (#675). */
export async function handledFailure(
  handled: ExecutionStateUpdate,
  site: Parameters<typeof compensationsOfVisit>[0] & {
    readonly state: ExecutionStateType;
    readonly deps: VisitDeps;
    readonly clock: Clock;
    readonly isHeldBack: boolean;
    readonly reported: { readonly compensations: readonly CompensationEntry[] };
  },
): Promise<ExecutionStateUpdate> {
  const { deps, clock, isHeldBack, reported, state, frame } = site;
  const own = await failedCompensations(site, deps, { isHeldBack, clock });
  // #1281: what the step's finished children left open is undone before the side path runs
  const held = await heldEntriesUndone({ state, frame, deps, clock, cause: site.failure });
  const entries = [...(held?.compensations ?? []), ...reported.compensations];
  const withHeld = { ...own, usage: [...(held?.usage ?? []), ...(own.usage ?? [])] };
  return withOwnCompensations(handled, entries, withHeld);
}

/**
 * #1281 (10): a launch stopped at its dispatch into its join's `.onError` (`maxItems`, the quorum
 * deadline's calendar) undoes what the children held before the side path, as a failed join does —
 * the entries this step just took from its own child too: `visited` is the step's update, its
 * entries open.
 */
export async function stoppedAtDispatch(
  visited: ExecutionStateUpdate,
  site: StepErrorSite,
): Promise<ExecutionStateUpdate> {
  const opened = Array.isArray(visited.compensations) ? visited.compensations : [];
  const compensations = mergeCompensations(site.state.compensations, opened);
  const held = await heldEntriesUndone({ ...site, state: { ...site.state, compensations } });
  return withHeldUndone(visited, held);
}
