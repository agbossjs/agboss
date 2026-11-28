/** #1279, #1356 (WP6, unwind shard): what `isSkippedBranch` takes for a recorded error, and what it does not. */
import { describe, expect, it } from "vitest";
import { errorRecordOf } from "../../../src/core/error-record.js";
import { AGBossError } from "../../../src/core/errors.js";
import { isSkippedBranch, skipCodesOf } from "../../../src/flow/runtime/launch/branch-skip.js";

class DomainError extends AGBossError {
  static override readonly code: string = "test.domain";
}

describe("isSkippedBranch: what was thrown", () => {
  const skipDomain = { skip: skipCodesOf([DomainError]) };
  const skipAny = { skip: skipCodesOf([Error]) };

  it("takes a recorded error by its lineage, and an object that is not one by what it throws as", () => {
    expect(isSkippedBranch(skipDomain, errorRecordOf(new DomainError("x")))).toBe(true);
    expect(isSkippedBranch(skipDomain, { message: "plain object" })).toBe(false);
    expect(isSkippedBranch(skipAny, { message: "plain object" })).toBe(true);
  });

  it("an Error with a lineage of its own is still an error, never a record", () => {
    const error = Object.assign(new Error("x"), { lineage: ["test.domain"] });

    expect(isSkippedBranch(skipDomain, error)).toBe(false);
    expect(isSkippedBranch(skipAny, error)).toBe(true);
  });

  it.each([null, undefined, "text", 7, true])(
    "a thrown %s drops out of skip(Error) and nothing else",
    (thrown) => {
      expect(isSkippedBranch(skipAny, thrown)).toBe(true);
      expect(isSkippedBranch(skipDomain, thrown)).toBe(false);
    },
  );

  it("an object whose lineage is no list is no record", () => {
    expect(isSkippedBranch(skipDomain, { lineage: "test.domain" })).toBe(false);
  });

  it("no skip, or none listed, drops nothing, whatever was thrown", () => {
    expect(isSkippedBranch({}, null)).toBe(false);
    expect(isSkippedBranch({ skip: [] }, new Error("x"))).toBe(false);
  });

  it("any one of several codes drops a branch", () => {
    const skip = skipCodesOf([DomainError, TypeError]);

    expect(isSkippedBranch({ skip }, new DomainError("x"))).toBe(true);
    expect(isSkippedBranch({ skip }, new RangeError("x"))).toBe(false);
  });
});
