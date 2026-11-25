import { AGBossError } from "./errors.js";

/**
 * A value or the error that took its place (#1325): `{ ok: true, value }` or `{ ok: false, error }`,
 * narrowed by `res.ok`. A utility for a caller that handles a failure where it happens — no `App`
 * method returns one: they return their value and reject. Make one with `Result.ok`, `Result.err`,
 * or wrap a call with `Result.try` (a framework error becomes an `Err`) or `Result.tryAll` (any).
 */
export type Result<T, E = AGBossError> = Result.Ok<T> | Result.Err<E>;

/** The two outcomes of a `Result`. */
export declare namespace Result {
  /** The call went through: its value. */
  export interface Ok<T> {
    readonly ok: true;
    readonly value: T;
    /** The value. */
    unwrap(): T;
    /** The value; the fallback is never used. */
    unwrapOr(fallback: unknown): T;
    /** An `Ok` of the value changed by `fn`. */
    map<U>(fn: (value: T) => U): Ok<U>;
    /** Itself: there is no error to change. */
    mapErr(fn: (error: never) => unknown): Ok<T>;
  }

  /** The call failed: its error. */
  export interface Err<E> {
    readonly ok: false;
    readonly error: E;
    /** Throws the error. */
    unwrap(): never;
    /** The fallback. */
    unwrapOr<U>(fallback: U): U;
    /** Itself: there is no value to change. */
    map(fn: (value: never) => unknown): Err<E>;
    /** An `Err` of the error changed by `fn`. */
    mapErr<F>(fn: (error: E) => F): Err<F>;
  }
}

class OkResult<T> implements Result.Ok<T> {
  readonly ok = true as const;

  constructor(readonly value: T) {}

  unwrap(): T {
    return this.value;
  }

  unwrapOr(): T {
    return this.value;
  }

  map<U>(fn: (value: T) => U): Result.Ok<U> {
    return new OkResult(fn(this.value));
  }

  mapErr(): Result.Ok<T> {
    return this;
  }
}

class ErrResult<E> implements Result.Err<E> {
  readonly ok = false as const;

  constructor(readonly error: E) {}

  unwrap(): never {
    if (this.error instanceof Error) throw this.error;
    throw new Error("the Result holds a failure that is not an Error", { cause: this.error });
  }

  unwrapOr<U>(fallback: U): U {
    return fallback;
  }

  map(): Result.Err<E> {
    return this;
  }

  mapErr<F>(fn: (error: E) => F): Result.Err<F> {
    return new ErrResult(fn(this.error));
  }
}

/** What `Result.try(fn)` gives, by what `fn` returns: a promise of a `Result` for an async `fn`. */
export type TryOutcome<T, E> = [T] extends [never]
  ? Result<never, E>
  : T extends PromiseLike<infer U>
    ? Promise<Result<U, E>>
    : Result<T, E>;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/** Runs `fn`, keeping the failures `keeps` accepts as `Err`; any other is thrown again. */
function attempt(fn: () => unknown, keeps: (error: unknown) => boolean): unknown {
  const failed = (error: unknown): Result.Err<unknown> => {
    if (!keeps(error)) throw error;
    return new ErrResult(error);
  };
  let returned: unknown;
  try {
    returned = fn();
  } catch (error) {
    return failed(error);
  }
  if (!isThenable(returned)) return new OkResult(returned);
  return Promise.resolve(returned).then((value) => new OkResult(value), failed);
}

/**
 * Runs `fn`; a framework error (`AGBossError`) it throws, or its promise rejects with, becomes
 * `{ ok: false, error }` — any other (a `TypeError`, a `RangeError`: a bug) is thrown again, never
 * dressed as a failure of the call. Give `async () => …` to chain `.then()` straight on the result.
 */
function tryResult<T>(fn: () => T): TryOutcome<T, AGBossError>;
function tryResult(fn: () => unknown): unknown {
  return attempt(fn, (error) => error instanceof AGBossError);
}

/** Like `Result.try`, for what throws anything — a third-party SDK call: every failure is an `Err`. */
function tryAll<T>(fn: () => T): TryOutcome<T, unknown>;
function tryAll(fn: () => unknown): unknown {
  return attempt(fn, () => true);
}

/** What `Result` offers: its two makers and the two wrappers. */
export interface ResultFactory {
  /** An `Ok` of `value`. */
  ok<T>(value: T): Result.Ok<T>;
  /** An `Err` of `error`. */
  err<E>(error: E): Result.Err<E>;
  /**
   * Runs `fn`; a framework error (`AGBossError`) it throws, or its promise rejects with, becomes
   * `{ ok: false, error }` — any other (a `TypeError`, a `RangeError`: a bug) is thrown again, never
   * dressed as a failure of the call. Give `async () => …` to chain `.then()` straight on the result.
   */
  try<T>(fn: () => T): TryOutcome<T, AGBossError>;
  /** Like `Result.try`, for what throws anything — a third-party SDK call: every failure is an `Err`. */
  tryAll<T>(fn: () => T): TryOutcome<T, unknown>;
}

/** `Result.ok(value)`, `Result.err(error)`, `Result.try(fn)`, `Result.tryAll(fn)`. */
export const Result: ResultFactory = {
  ok: (value) => new OkResult(value),
  err: (error) => new ErrResult(error),
  try: tryResult,
  tryAll,
};
