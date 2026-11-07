// #831: a sabotage fixture that registers one suite, then throws while it registers the next (as a
// refused store set does): runConformanceSabotage must not hand back the first suite's cases.
import { describe, expect, it } from "vitest";

describe("registered first", () => {
  it("fails", () => {
    expect(1).toBe(2);
  });
});
throw new Error("the second suite was refused");
