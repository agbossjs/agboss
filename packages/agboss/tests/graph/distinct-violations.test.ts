import { describe, expect, it } from "vitest";
import { distinctViolations } from "../../src/graph/distinct-violations.js";
import { violation } from "../../src/graph/rule-error.js";

describe("distinctViolations", () => {
  it("keeps one violation per code and message, joining the nodes that reached it", () => {
    const found = distinctViolations([
      violation("limits.timeout-invalid", "a is too long", ["app"]),
      violation("limits.timeout-invalid", "b is too long", ["app"]),
      violation("limits.timeout-invalid", "a is too long", ["flow", "app"]),
    ]);

    expect(found).toEqual([
      violation("limits.timeout-invalid", "a is too long", ["app", "flow"]),
      violation("limits.timeout-invalid", "b is too long", ["app"]),
    ]);
  });
});
