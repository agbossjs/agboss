import type { Provenance } from "../analyse/outdating.js";
import type { ScopeRecords } from "./records.js";

/**
 * What a value is built from at run time (#271 rule 3, S11, S40) — the same rule the analyser's
 * abstract step applies (`analyse/outdating.ts`), on `valueId`s instead of slots: the values the
 * step read (its `input` fields; every current value for an agent without `input`, rule 8).
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
}

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
  return current
    .filter((record) => read.has(record.valueId))
    .map((record) => record.valueId)
    .sort();
}
