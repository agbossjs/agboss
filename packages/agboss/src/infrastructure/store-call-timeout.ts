import { StoreError } from "../core/error-families/store-errors.js";

/**
 * A store call whose outcome is unknown (#928): the request may have reached the store and taken
 * effect, and the caller never heard. The framework never takes such a call as done, and never as
 * not done: under a lease the holder hands the tree over and the next holder reconciles (the fenced
 * effect's row, the pending intent, the latest checkpoint); any other caller gets the error.
 */

/** Who found that a store call's outcome is unknown. */
export enum StoreOutcomeSource {
  /** The store package's own command timeout fired (the driver's error is the cause). */
  Command = "command",
  /** The framework's bound fired: the store never answered. */
  Framework = "framework",
  /** A transport error after the request was sent (#1017). */
  Transport = "transport",
}

/** A store call whose outcome is unknown: it never answered (`CallTimeout`) or the answer was lost (`OutcomeUnknown`). */
export type StoreOutcomeUnknown = StoreError.OutcomeUnknown | StoreError.CallTimeout;

/**
 * Whether `error` is a store call of unknown outcome: `StoreError.OutcomeUnknown`, or its neighbour
 * `StoreError.CallTimeout` (a variant of its own, not a subclass of the first).
 */
export const isStoreOutcomeUnknown = (error: unknown): error is StoreOutcomeUnknown =>
  error instanceof StoreError.OutcomeUnknown || error instanceof StoreError.CallTimeout;
