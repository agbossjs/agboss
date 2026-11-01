import { describe, expect, it } from "vitest";
import { definedOf } from "../../src/infrastructure/clock.js";

describe("definedOf (#619): an invariant's value, checked outside the caller's branches", () => {
  it("gives a defined value as it is — falsy ones too", () => {
    const lease = { leaseEpoch: 1 };

    expect(definedOf(lease, "held")).toBe(lease);
    expect(definedOf(0, "a count")).toBe(0);
    expect(definedOf(null, "a row")).toBeNull();
    expect(definedOf(false, "a flag")).toBe(false);
  });

  it("throws for undefined, naming the invariant broken", () => {
    expect(() => {
      definedOf(undefined, "the lease is held");
    }).toThrow(new Error("unreachable: the lease is held"));
  });
});
