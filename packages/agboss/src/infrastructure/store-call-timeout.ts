import { AGBossError, type AGBossErrorOptions } from "../core/errors.js";
import type { Milliseconds } from "../units/index.js";

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

/** What a store call of unknown outcome knows: the store, the call, who found it out. */
export interface StoreOutcomeUnknownErrorOptions extends AGBossErrorOptions {
  /** The store class, or the connection, the call went to. */
  readonly store: string;
  /** The contract method, or the driver command. */
  readonly operation: string;
  readonly source: StoreOutcomeSource;
}

/** A store call whose outcome is unknown: it may have taken effect. */
export class StoreOutcomeUnknownError extends AGBossError {
  static override readonly code: string = "store.outcome-unknown";
  /** This class's code, or its subclass `StoreCallTimeoutError`'s (#906: `switch (error.code)` narrows). */
  declare readonly code: "store.outcome-unknown" | "store.call-timeout";
  override name = "StoreOutcomeUnknownError";
  readonly store: string;
  readonly operation: string;
  readonly source: StoreOutcomeSource;

  constructor(options: StoreOutcomeUnknownErrorOptions & { readonly message?: string }) {
    const { store, operation, source, cause, details } = options;
    super(
      options.message ??
        `${store}.${operation} failed after it was sent (${source}): its outcome is unknown — it may have taken effect`,
      { cause, details },
    );
    this.store = store;
    this.operation = operation;
    this.source = source;
  }
}

/** What a store call that was not answered in time knows: the limit it was given. */
export interface StoreCallTimeoutErrorOptions extends StoreOutcomeUnknownErrorOptions {
  readonly timeout: Milliseconds;
}

/** A store call not answered within `timeout`: its outcome is unknown. */
export class StoreCallTimeoutError extends StoreOutcomeUnknownError {
  static override readonly code = "store.call-timeout" as const;
  declare readonly code: typeof StoreCallTimeoutError.code;
  override name = "StoreCallTimeoutError";
  readonly timeout: Milliseconds;

  constructor(options: StoreCallTimeoutErrorOptions) {
    const { store, operation, source, timeout } = options;
    super({
      ...options,
      message: `${store}.${operation} did not answer within ${String(timeout)} ms (${source}): its outcome is unknown — it may have taken effect`,
    });
    this.timeout = timeout;
  }
}
