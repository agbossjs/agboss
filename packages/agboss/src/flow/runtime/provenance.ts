import type { ValueWrite } from "../analyse/flow-graph.js";
import type { Provenance } from "../analyse/outdating.js";
import { aboutOfWrite, slotOfWrite } from "../analyse/scope.js";
import type { ScopeRecords, ScopeValueRecord } from "./records.js";

/**
 * What a value is built from at run time (#271 rule 3, S11, S40) — the same rule the analyser's
 * abstract step applies (`analyse/outdating.ts`), on `valueId`s instead of slots: the values the
 * step read (its `input` fields; every current value for an agent without `input`, rule 8), minus
 * the answers about what the step writes (rule 5: a new draft never counts the notes about the old
 * one, so a new note never outdates it). Each write adds its own `{ about }` targets (`scope.ts`).
 * Only current values are ever read: the scope holds nothing else.
 */

/** The analyser's provenance tables, keyed by plain names for the runtime's records. */
export interface RuntimeProvenance {
  /** Agents without `input`: built from every current value (rule 8). */
  readonly readsEverything: ReadonlySet<string>;
}

export const runtimeProvenanceOf = (provenance: Provenance): RuntimeProvenance => ({
  readsEverything: new Set<string>(provenance.readsEverything),
});

/** One step's write, as provenance reads it. */
export interface ProvenanceSite {
  /** The node that wrote (its `name`). */
  readonly producer: string;
  /** The `valueId`s its fields read. */
  readonly read: readonly string[];
  /** What its way out writes. */
  readonly writes: readonly ValueWrite[];
}

/** Whether a record is an answer about one of the written slots (it does not count, rule 5). */
const isAboutWritten = (record: ScopeValueRecord, written: ReadonlySet<string>): boolean =>
  (record.about ?? []).some((target) => written.has(target));

/** The `valueId`s the values a step writes are built from, sorted. */
export function builtFromOf(
  site: ProvenanceSite,
  scope: ScopeRecords,
  provenance: RuntimeProvenance,
): readonly string[] {
  const current = Object.values(scope);
  const read = new Set(
    provenance.readsEverything.has(site.producer)
      ? current.map((record) => record.valueId)
      : site.read,
  );
  const written = new Set<string>(site.writes.map(slotOfWrite));
  return current
    .filter((record) => read.has(record.valueId))
    .filter((record) => !isAboutWritten(record, written))
    .map((record) => record.valueId)
    .sort();
}

/** What one value of a write records of its provenance: its sources and what it is about. */
export interface WrittenProvenance {
  readonly builtFrom: readonly string[];
  /** The slots of its `{ about }` (#299 S54); empty when it is about nothing. */
  readonly about: readonly string[];
}

/**
 * One write's provenance: the step's sources plus the current values of its own `{ about }`
 * targets (S40 b — an answer is built from what it is about even when its step does not read it).
 */
export function writtenProvenanceOf(
  builtFrom: readonly string[],
  write: ValueWrite,
  scope: ScopeRecords,
  writes: readonly ValueWrite[] = [write],
): WrittenProvenance {
  const about = aboutOfWrite(write);
  const written = new Set<string>(writes.map(slotOfWrite));
  // a target that is itself an answer about what the step writes does not count (rule 5)
  const targets = about.flatMap((target) => {
    const record = scope[target];
    return record === undefined || isAboutWritten(record, written) ? [] : [record.valueId];
  });
  return { builtFrom: [...new Set([...builtFrom, ...targets])].sort(), about };
}
