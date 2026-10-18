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

/** Why a value reached by a cascade was outdated: through what it is about, or what it read. */
function reasonOf(
  record: ScopeValueRecord,
  outdated: ReadonlyMap<string, ScopeValueRecord>,
): OutdatedReason {
  const about = record.about ?? [];
  const isAbout = record.builtFrom.some((source) => {
    const cause = outdated.get(source);
    return cause !== undefined && about.includes(cause.slot);
  });
  return isAbout ? OutdatedReason.AboutReplaced : OutdatedReason.BuiltFromReplaced;
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
    const older = scope[trigger.slot];
    if (older === undefined) continue;
    replaced.add(older.valueId);
    for (const valueId of reachedFrom(older, rest))
      if (!rootOf.has(valueId)) rootOf.set(valueId, trigger);
  }
  const old = Object.values(scope).filter((record) => rootOf.has(record.valueId));
  const outdatedById = new Map(old.map((record) => [record.valueId, record] as const));
  const outdated = old
    .map((record): OutdatedValueRecord => {
      const reason = replaced.has(record.valueId)
        ? OutdatedReason.Replaced
        : reasonOf(record, outdatedById);
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
