import { lazyLoad, type Clock } from "../../infrastructure/clock.js";
import {
  compensationsOfHeldVisit,
  compensationsOfVisit,
  type CompensationEntry,
  type HeldUndo,
} from "../compensation.js";
import { hasHeldEntries } from "./compensation/held-entries.js";
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
  own: HeldUndo,
): ExecutionStateUpdate {
  const compensations = [...childEntries, ...(own.compensations ?? [])];
  const visitUsage = Array.isArray(handled.usage) ? handled.usage : [];
  const usage = [...visitUsage, ...(own.usage ?? [])];
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
  const held = hasHeldEntries(state.compensations, frame.execution.executionId)
    ? await (
        await lazyLoad(import("./compensation/step-error-undo.js"))
      ).undoneHeldEntries({ state, frame, deps, clock, cause: site.failure })
    : undefined;
  const entries = [...(held?.compensations ?? []), ...reported.compensations];
  const withHeld = { ...own, usage: [...(held?.usage ?? []), ...(own.usage ?? [])] };
  return withOwnCompensations(handled, entries, withHeld);
}
