import { twinSlotsOf } from "../analyse/slices.js";
import type { SlotKey } from "../analyse/scope.js";
import {
  OutdatedReason,
  type OutdatedValueRecord,
  type ScopeRecords,
  type ScopeValueRecord,
} from "./records.js";

/**
 * The outdating cascade at run time (#271 S11, S40 — the runtime twin of the analyser's abstract
 * step): a write replaces the older value of each slot it fills; every current value built from a
 * replaced or outdated value is outdated too, recursively. Outdated values leave `scope` in the same
 * step for the append-only `outdatedValues`, so nothing that reads inputs, prompts or a finish can
 * see them. The cascade starts from current values only.
 * `byValueId` is always the root trigger — the new value whose write started the chain — the same
 * whatever order the cascade is walked in. The new values keep only their live sources.
 */

/** One cascade: the new value that started it and what it outdated (never empty). */
export interface OutdatingCascade {
  readonly trigger: ScopeValueRecord;
  readonly outdated: readonly OutdatedValueRecord[];
}

/** The scope after one write, and what the write outdated. */
export interface WriteOutcome {
  readonly scope: ScopeRecords;
  readonly outdated: readonly OutdatedValueRecord[];
  /** The outdated values grouped by their root trigger, one cascade per trigger. */
  readonly cascades: readonly OutdatingCascade[];
}

/** Every current value reached from `root`, the replaced older value of a written slot. */
function reachedFrom(root: ScopeValueRecord, rest: readonly ScopeValueRecord[]): Set<string> {
  const reached = new Set([root.valueId]);
  const queue = [root.valueId];
  for (let cause = queue.shift(); cause !== undefined; cause = queue.shift()) {
    for (const record of rest) {
      if (reached.has(record.valueId) || !record.builtFrom.includes(cause)) continue;
      reached.add(record.valueId);
      queue.push(record.valueId);
    }
  }
  return reached;
}

const byValueId = (first: ScopeValueRecord, second: ScopeValueRecord): number =>
  first.valueId.localeCompare(second.valueId);

/** The replaced values first, then the rest of the cascade, each by `valueId`. */
const inReportOrder = (first: OutdatedValueRecord, second: OutdatedValueRecord): number => {
  const firstReplaced = first.outdated.reason === OutdatedReason.Replaced ? 0 : 1;
  const secondReplaced = second.outdated.reason === OutdatedReason.Replaced ? 0 : 1;
  return firstReplaced - secondReplaced || byValueId(first, second);
};

/**
 * A new value keeps in `builtFrom` only the sources still current after its write (S40 c, as the
 * analyser's step): a source its own write outdated can never outdate it again, so the record shows
 * the provenance the analysis reasons about.
 */
function liveSourcesOf(record: ScopeValueRecord, live: ReadonlySet<string>): ScopeValueRecord {
  const builtFrom = record.builtFrom.filter((source) => live.has(source));
  return builtFrom.length === record.builtFrom.length ? record : { ...record, builtFrom };
}

/** Writes `written` into `scope` and outdates what the write makes stale. */
export function writeAndOutdate(scope: ScopeRecords, written: ScopeRecords): WriteOutcome {
  const triggers = Object.values(written).sort(byValueId);
  const rest = Object.values(scope).filter((record) => written[record.slot] === undefined);
  const rootOf = new Map<string, ScopeValueRecord>();
  const replaced = new Set<string>();
  for (const trigger of triggers) {
    // the value it replaces, and the twins it makes stale: the slices of a polymorphic list, the lists a slice is part of (#1288b)
    const stale = [
      scope[trigger.slot],
      ...twinSlotsOf(
        trigger.slot as SlotKey,
        rest.map((record) => record.slot as SlotKey),
      ).map((slot) => scope[slot]),
    ].filter((record) => record !== undefined);
    for (const older of stale) {
      replaced.add(older.valueId);
      for (const valueId of reachedFrom(older, rest))
        if (!rootOf.has(valueId)) rootOf.set(valueId, trigger);
    }
  }
  const old = Object.values(scope).filter((record) => rootOf.has(record.valueId));
  const outdated = old
    .map((record): OutdatedValueRecord => {
      const reason = replaced.has(record.valueId)
        ? OutdatedReason.Replaced
        : OutdatedReason.BuiltFromReplaced;
      const root = rootOf.get(record.valueId)?.valueId ?? "";
      return { ...record, outdated: { byValueId: root, reason } };
    })
    .sort(inReportOrder);
  const kept = Object.values(scope).filter((record) => !rootOf.has(record.valueId));
  const live = new Set(kept.map((record) => record.valueId));
  const added = triggers.map((trigger) => liveSourcesOf(trigger, live));
  const next = Object.fromEntries(
    [...kept, ...added].map((record) => [record.slot, record] as const),
  );
  const cascades = added
    .map((trigger) => ({
      trigger,
      outdated: outdated.filter((record) => record.outdated.byValueId === trigger.valueId),
    }))
    .filter((cascade) => cascade.outdated.length > 0);
  return { scope: next, outdated, cascades };
}
