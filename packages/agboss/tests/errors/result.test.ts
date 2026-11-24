/**
 * #1325a: `Result<T, E>` — a value or the error that took its place. `Result.try` keeps only a framework
 * error (`AGBossError`) as an `Err` and throws every other again — a bug is never dressed as a failure of
 * the call; `Result.tryAll` keeps whatever was thrown. Sync or async by what `fn` returns.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import { AGBossError, LimitError, Result, StepError } from "../../src/index.js";

const limit = (): LimitError.Visits =>
  new LimitError.Visits({ nodeId: "a", limit: 1, actual: 2, path: [], spentUsd: 0 });

describe("#1325a: Result.ok and Result.err", () => {
  it("an Ok holds its value, unwraps to it and ignores a fallback", () => {
    const ok = Result.ok(3);

    expect(ok).toMatchObject({ ok: true, value: 3 });
    expect(ok.unwrap()).toBe(3);
    expect(ok.unwrapOr(9)).toBe(3);
    expect(ok.map((value) => value * 2)).toMatchObject({ ok: true, value: 6 });
    expect(ok.mapErr(() => "never")).toBe(ok);
  });

  it("an Err holds its error, throws it on unwrap, gives the fallback, keeps itself under map", () => {
    const failure = limit();
    const err = Result.err(failure);

    expect(err).toMatchObject({ ok: false, error: failure });
    expect(() => err.unwrap()).toThrow(failure);
    expect(err.unwrapOr(9)).toBe(9);
    expect(err.map(() => 1)).toBe(err);
    expect(err.mapErr((error) => error.kind)).toMatchObject({ ok: false, error: "visits" });
  });

  it("unwrap of an Err that holds no Error throws an Error with it as the cause", () => {
    const err = Result.err("plain text");

    expect(() => err.unwrap()).toThrow(Error);
    expect(() => err.unwrap()).toThrow(expect.objectContaining({ cause: "plain text" }));
  });

  it("narrows by `ok`", () => {
    const narrow = (result: Result<number, LimitError>): void => {
      if (result.ok) expectTypeOf(result.value).toEqualTypeOf<number>();
      else expectTypeOf(result.error).toEqualTypeOf<LimitError>();
    };

    narrow(Result.ok(1));
    expect(Result.ok(1).ok).toBe(true);
  });
});

describe("#1325a: Result.try", () => {
  it("a sync value is an Ok; a sync AGBossError an Err", () => {
    const failure = limit();

    expect(Result.try(() => 7)).toMatchObject({ ok: true, value: 7 });
    expect(
      Result.try(() => {
        throw failure;
      }),
    ).toMatchObject({ ok: false, error: failure });
  });

  it("a sync error that is no AGBossError — a bug — is thrown again", () => {
    expect(() =>
      Result.try(() => {
        throw new TypeError("a bug");
      }),
    ).toThrow(TypeError);
  });

  it("an async fn gives a promise of a Result: Ok, or Err for an AGBossError", async () => {
    const failure = new StepError.Action({
      action: "charge",
      nodeId: "charge",
      visitNumber: 1,
      component: bareRecordOf("charge", ComponentKind.Action),
    });

    const ok = await Result.try(async () => Promise.resolve("done"));
    const err = await Result.try(async () => Promise.reject(failure));

    expect(ok).toMatchObject({ ok: true, value: "done" });
    expect(err).toMatchObject({ ok: false, error: failure });
  });

  it("a promise that rejects with a non-AGBossError rejects the same way", async () => {
    await expect(Result.try(async () => Promise.reject(new RangeError("a bug")))).rejects.toThrow(
      RangeError,
    );
  });

  it("a fn that returns a thenable is awaited", async () => {
    const thenable: PromiseLike<number> = {
      then: (resolve) => Promise.resolve(5).then(resolve),
    };

    expect(await Result.try(() => thenable)).toMatchObject({ ok: true, value: 5 });
  });

  it("types: a promise for an async fn, a Result for a sync one, never for a fn that throws", () => {
    const sync = Result.try(() => 1);
    const async = Result.try(async () => Promise.resolve(1));
    const never = Result.try((): never => {
      throw limit();
    });

    expectTypeOf(sync).toEqualTypeOf<Result<number>>();
    expectTypeOf(async).toEqualTypeOf<Promise<Result<number>>>();
    expectTypeOf(never).toEqualTypeOf<Result<never>>();
    expect(never.ok).toBe(false);
    return async;
  });
});

describe("#1325a: Result.tryAll", () => {
  it("keeps whatever was thrown — a third-party SDK's error, a string — as an Err", async () => {
    class SdkError extends Error {}
    const sdk = new SdkError("down");

    expect(
      Result.tryAll(() => {
        throw sdk;
      }),
    ).toMatchObject({ ok: false, error: sdk });
    expect(await Result.tryAll(async () => Promise.reject(new Error("text")))).toMatchObject({
      ok: false,
      error: new Error("text"),
    });
    expect(Result.tryAll(() => 1)).toMatchObject({ ok: true, value: 1 });
    expectTypeOf(Result.tryAll(() => 1)).toEqualTypeOf<Result<number, unknown>>();
  });
});
