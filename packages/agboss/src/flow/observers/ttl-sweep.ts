import type { ObservedFailure } from "./failure.js";

/** What one look of the sweep did to one kind of rows. */
export interface TtlSweepCategory {
  /** The rows: `"the resolved pause records"`, `"the audit log's old rows"`, … */
  readonly category: string;
  /** How many rows were removed; `undefined` when the store does not count them, or it failed. */
  readonly removed: number | undefined;
  /** Why the store could not remove them; asked again at the next look. */
  readonly error?: ObservedFailure;
}

/**
 * A look of the retention sweep ended (#1343, `onTtlSweep`): what every kind of rows past its
 * retention lost, how long the look took and which stores failed. An event of the application: no
 * `workflows` / `agents` filter lets it through. Only kinds that have a retention are listed.
 */
export interface TtlSweepEvent {
  /** When the look began, on the application's clock. */
  readonly at: Date;
  /** How long it took, on the application's clock (ms). */
  readonly durationMs: number;
  readonly categories: readonly TtlSweepCategory[];
}
