import { describe, expect, it } from "vitest";
import * as internal from "../../src/internal.js";
import * as testing from "../../src/testing/index.js";

describe("#895: workflowOf and toolOf are internal", () => {
  it("are in /internal, no longer in /testing", () => {
    expect(internal.workflowOf).toBeTypeOf("function");
    expect(internal.toolOf).toBeTypeOf("function");
    expect(testing).not.toHaveProperty("workflowOf");
    expect(testing).not.toHaveProperty("toolOf");
  });

  it("the replacements stay in /testing", () => {
    for (const name of ["testWith", "testTool"]) expect(testing).toHaveProperty(name);
  });
});
