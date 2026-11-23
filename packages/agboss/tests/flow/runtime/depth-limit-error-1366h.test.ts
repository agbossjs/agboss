/**
 * #1366: the depth limit error names its limit — `key` is maxDepth, and its details carry the workflow, the
 * limit and the depth the launch would have started at.
 */
import { describe, expect, it } from "vitest";
import { DepthLimitExceededError } from "../../../src/flow/runtime/depth-limit.js";

describe("#1366: DepthLimitExceededError", () => {
  it("carries the key, the limit, the depth and the workflow's record in its details", () => {
    const workflow = {
      name: "countdown",
      version: "1.0.0",
      startedVersion: "1.0.0",
      configHash: "abc",
    } as never;
    const error = new DepthLimitExceededError({ workflow, maxDepth: 3, path: ["countdown"] });

    expect(error.key).toBe("maxDepth");
    expect(error.limit).toBe(3);
    expect(error.actual).toBe(4);
    expect(error.depth).toBe(4);
    expect(error.code).toBe("limit.depth");
    expect(error.details).toMatchObject({
      key: "maxDepth",
      limit: 3,
      actual: 4,
      maxDepth: 3,
      depth: 4,
      workflow: { name: "countdown", version: "1.0.0", startedVersion: "1.0.0", configHash: "abc" },
    });
  });
});
