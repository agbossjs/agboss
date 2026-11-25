import { usd } from "../../src/units/index.js";
/**
 * #1325a: what a record and a handler read of a class — its own `static code`, never an inherited one —
 * and `RecordedError`, the failure rebuilt from a record, which is an `AGBossError` like the original.
 */
import { describe, expect, it } from "vitest";
import {
  codeOfErrorClass,
  durableErrorOf,
  errorMatchOf,
  errorRecordOf,
  RecordedError,
  recordedErrorOf,
} from "../../src/core/error-record.js";
import { AGBossError, LimitError, Result } from "../../src/index.js";

class CardError extends AGBossError {
  static override readonly code: string = "card";
}
/** A project's class that declares no code: it must not inherit `card` or `agboss`. */
class CardDeclinedError extends CardError {}
class PlainProjectError extends AGBossError {}

describe("#1325a: a class is caught by its own code, never an inherited one", () => {
  it("a class without a `static code` of its own is caught by its name", () => {
    expect(codeOfErrorClass(PlainProjectError)).toBe("PlainProjectError");
    expect(codeOfErrorClass(CardDeclinedError)).toBe("CardDeclinedError");
    expect(codeOfErrorClass(CardError)).toBe("card");
    expect(codeOfErrorClass(AGBossError)).toBe("agboss");
    expect(codeOfErrorClass(Error)).toBeUndefined();
  });

  it("its record's class line names it, then the parents that have a code, then agboss", () => {
    const record = errorRecordOf(new CardDeclinedError("declined"));

    expect(record.lineage).toEqual(["CardDeclinedError", "card", "agboss"]);
    expect(errorMatchOf(record, codeOfErrorClass(CardDeclinedError))).toEqual({
      distance: 0,
      depth: 0,
    });
    expect(errorMatchOf(record, codeOfErrorClass(CardError))).toEqual({ distance: 1, depth: 0 });
  });

  it("one project class does not catch another that inherits the same code", () => {
    const record = errorRecordOf(new PlainProjectError("x"));

    expect(errorMatchOf(record, codeOfErrorClass(CardDeclinedError))).toBeUndefined();
    expect(errorMatchOf(record, codeOfErrorClass(AGBossError))).toBeDefined();
  });

  it("a family's variant and its family are caught by their own codes", () => {
    const record = errorRecordOf(
      new LimitError.Visits({ nodeId: "a", limit: 1, actual: 2, path: [], spentUsd: usd(0) }),
    );

    expect(record.lineage).toEqual(["limit.visits", "limit", "agboss"]);
    expect(errorMatchOf(record, codeOfErrorClass(LimitError.Visits))?.distance).toBe(0);
    expect(errorMatchOf(record, codeOfErrorClass(LimitError))?.distance).toBe(1);
    expect(errorMatchOf(record, codeOfErrorClass(LimitError.Budget))).toBeUndefined();
  });
});

describe("#1325a: RecordedError is an AGBossError", () => {
  const original = new CardDeclinedError("declined", {
    cause: new LimitError.Items({ node: "n", limit: 1, actual: 2, path: [], spentUsd: usd(0) }),
  });

  it("is an AGBossError and an Error, with the original's name, message and code", () => {
    const rebuilt = recordedErrorOf(JSON.parse(JSON.stringify(durableErrorOf(original))));

    expect(rebuilt).toBeInstanceOf(RecordedError);
    expect(rebuilt).toBeInstanceOf(AGBossError);
    expect(rebuilt).toMatchObject({ name: "CardDeclinedError", message: "declined" });
    expect(rebuilt?.code).toBe("CardDeclinedError");
    expect(rebuilt?.cause).toBeInstanceOf(RecordedError);
    expect(rebuilt?.cause).toBeInstanceOf(AGBossError);
    expect(rebuilt?.record).toEqual(errorRecordOf(rebuilt));
  });

  it("Result.try keeps it as an Err, as it keeps the original", () => {
    const rebuilt = new RecordedError(errorRecordOf(original));

    expect(
      Result.try(() => {
        throw rebuilt;
      }),
    ).toMatchObject({ ok: false, error: rebuilt });
  });

  it("a failure that was no framework error keeps its own name and the neutral code", () => {
    const rebuilt = new RecordedError(errorRecordOf(new RangeError("a bug")));

    expect(rebuilt).toBeInstanceOf(AGBossError);
    expect(rebuilt.code).toBe("internal");
    expect(rebuilt.record.lineage).toEqual(["RangeError"]);
  });
});
