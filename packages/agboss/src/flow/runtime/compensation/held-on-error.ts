import type { UsageRecord } from "../../../finops/usage.js";
import { lazyLoad } from "../../../infrastructure/clock.js";
import { mergeCompensations, type CompensationEntry } from "../../compensation.js";
import type { ExecutionStateUpdate } from "../state.js";
import { hasHeldEntries } from "./held-entries.js";
import type { HeldEntriesUndone, StepErrorSite } from "./step-error-undo.js";

/**
 * #1281 (10): a failure an `.onError` takes undoes first what the execution's finished children left
 * open to it, whichever step failed — a plain step (`handledFailure`), a failed join (a branch that
 * failed, a quorum not reached) or a launch stopped at its dispatch (`maxItems`, the quorum deadline's
 * calendar) — so whether the failing step stands inside `.inParallel` changes nothing. It runs after
 * the launch's own entries were undone and before the side path; the undo runtime is loaded only when
 * such an entry is open.
 */

/** The held entries undone before the side path; `undefined` when none is open. */
export async function heldEntriesUndone(
  site: StepErrorSite,
): Promise<HeldEntriesUndone | undefined> {
  if (!hasHeldEntries(site.state.compensations, site.frame.execution.executionId)) return undefined;
  const { undoneHeldEntries } = await lazyLoad(import("./step-error-undo.js"));
  return undoneHeldEntries(site);
}

const arrayOf = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

/** The update with the held undo's entries and spend after its own. */
export function withHeldUndone(
  update: ExecutionStateUpdate,
  held: HeldEntriesUndone | undefined,
): ExecutionStateUpdate {
  if (held === undefined) return update;
  // an entry the update holds open (taken from a child by the same visit) is replaced by its close
  const compensations = mergeCompensations(
    arrayOf(update.compensations) as readonly CompensationEntry[],
    held.compensations,
  );
  const usage = [...(arrayOf(update.usage) as readonly UsageRecord[]), ...held.usage];
  return { ...update, usage, ...(compensations.length === 0 ? {} : { compensations }) };
}
