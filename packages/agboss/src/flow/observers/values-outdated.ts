import type { OutdatedValueReference, ScopeValueReference } from "../runtime/records.js";
import type { NodeEvent } from "./execution-event.js";

/**
 * The observer event of an outdating (#271 S12): one per cascade, only when something was outdated.
 * Plain data, never a DTO value — the values themselves are in `result.record` (`outdatedValues`).
 */

/**
 * A write outdated values (`onValuesOutdated`): `step` (the writing step) wrote `trigger`, which outdated `outdated` —
 * the whole cascade, the same set (and order) as it adds to `result.record.outdatedValues`.
 */
export interface ValuesOutdatedEvent extends NodeEvent {
  /** The new value: the root trigger of the cascade (`byValueId` of every outdated value). */
  readonly trigger: ScopeValueReference;
  /** Never empty: the replaced value, then what was built from it, each with its reason. */
  readonly outdated: readonly OutdatedValueReference[];
}
