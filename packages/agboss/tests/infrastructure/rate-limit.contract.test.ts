/**
 * #265 AC1: `ExecutionSlotRepository` does not exist (S27). The published rate limit contract runs
 * on the core's stores through `storeConformance` (#526, store-conformance.*.test.ts).
 */
import { describe, expect, it } from "vitest";
import * as agboss from "../../src/index.js";

describe("#265 AC1 (S27): the contracts", () => {
  it("ExecutionSlotRepository does not exist (S27); the three shared contracts do", () => {
    expect("ExecutionSlotRepository" in agboss).toBe(false);
    expect(agboss.RateLimitRepository).toBeTypeOf("function");
    expect(agboss.ExecutionTreeRepository).toBeTypeOf("function");
    expect(agboss.ExecutionLeaseRepository).toBeTypeOf("function");
  });
});
