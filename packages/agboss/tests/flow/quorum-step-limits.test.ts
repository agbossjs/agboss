/**
 * #1366: what `.joinQuorum({ deadline })` takes — a positive duration within the timer's cap, a deadline of nothing
 * or below it refused when the flow is built, and a `max` below `min` refused.
 */
import { describe, expect, it } from "vitest";
import { countQuorumOf } from "../../src/flow/quorum-step.js";
import { MAX_DEADLINE } from "../../src/units/timer-limits.js";

describe("#1366: the options of a count quorum", () => {
  it("a deadline of zero or below is refused, one millisecond is taken", () => {
    expect(() => countQuorumOf({ min: 1, deadline: 0 })).toThrow("positive duration");
    expect(() => countQuorumOf({ min: 1, deadline: -5 })).toThrow("positive duration");
    expect(countQuorumOf({ min: 1, deadline: 1 })).toMatchObject({ deadline: 1 });
  });

  it("a deadline above the timer's cap is refused, the cap itself is taken", () => {
    expect(() => countQuorumOf({ min: 1, deadline: MAX_DEADLINE + 1 })).toThrow("deadline");
    expect(countQuorumOf({ min: 1, deadline: MAX_DEADLINE })).toMatchObject({
      deadline: MAX_DEADLINE,
    });
  });

  it("a max below min is refused, a max equal to it is taken", () => {
    expect(() => countQuorumOf({ min: 3, max: 2 })).toThrow("at least min");
    expect(countQuorumOf({ min: 3, max: 3 })).toMatchObject({ min: 3, max: 3 });
  });
});
