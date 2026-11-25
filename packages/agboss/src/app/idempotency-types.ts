import type { JsonValue } from "../infrastructure/fenced-effect.repository.js";
import type { Bytes, Milliseconds, Ttl } from "../units/index.js";

/**
 * The shapes of `Idempotency.runOnce` (#1317), as types only: a keyed effect says what it does
 * (`fingerprint`) or on purpose that it says nothing (`withoutFingerprint: true`); an effect with
 * no key is one per step and name.
 */

/** What an effect under a key says about itself: its fingerprint, or `withoutFingerprint: true`. */
export type IdempotencyKeyChoice<TFingerprint> =
  | {
      /** A business identity (`"credit:42"`): the effect is one per tenant, name and key. */
      readonly key: string;
      /** What the effect does, plain JSON: another one under the same key is `IdempotencyError.KeyConflict`. */
      readonly fingerprint: JsonValue<TFingerprint>;
      readonly withoutFingerprint?: never;
    }
  | {
      readonly key: string;
      /** The key fixes the work by itself (an event applied once by its id): every call replays the first. */
      readonly withoutFingerprint: true;
      readonly fingerprint?: never;
    }
  | {
      /** No key: the effect is one per step and name. */
      readonly key?: undefined;
      readonly fingerprint?: never;
      readonly withoutFingerprint?: never;
    };

/** `Idempotency.runOnce`'s options. */
export type IdempotencyRunOptions<
  TResult,
  TFingerprint = never,
> = IdempotencyKeyChoice<TFingerprint> & {
  /** The effect's name (1–100 of `[A-Za-z0-9._-]`): several in one step are apart. */
  readonly name: string;
  /** How long the effect's result and its scope's mark are kept: above the lease's 30 s, or `Ttl.Forever`. */
  readonly ttl: Milliseconds | Ttl.Forever;
  /**
   * The bound of `execute` (default `seconds(15)`, below the lease's 30 s): a stalled one is rolled
   * back before its lease can expire.
   */
  readonly timeout?: Milliseconds;
  /** The largest stored result, in UTF-8 bytes of its JSON (default `kilobytes(64)`). */
  readonly maxResultSize?: Bytes;
  /**
   * The protected write, in the store's transaction with the result. It is handed no transaction:
   * a repository writes through its connection's `requireTransaction()`, which rolls back with the
   * effect on any uncaught error, identically on SQLite, PostgreSQL and MongoDB. It does nothing
   * else — no call to another system, nothing sent or counted outside (a store may run it again,
   * #730).
   */
  readonly execute: () => (TResult & JsonValue<TResult>) | Promise<TResult & JsonValue<TResult>>;
};
