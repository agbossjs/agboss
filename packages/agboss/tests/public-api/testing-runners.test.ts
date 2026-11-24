/**
 * #305 AC6: `@agboss/core/testing` exports the whole set of isolated unit runners (#262 S55) the skills
 * teach — one component on its own container each.
 */
import { describe, expect, it } from "vitest";
import * as testing from "../../src/testing/index.js";

const UNIT_RUNNERS = ["testUnit", "testDto", "testService", "testWith"] as const;

/** The per-kind runners of 0.1.0: `testUnit(Class)` is the one runner of a component now. */
const REMOVED_RUNNERS = [
  "testTool",
  "testAction",
  "testRouter",
  "testArbiter",
  "testRag",
  "testJudge",
  "testPii",
  "testGuardrail",
  "testToolInterceptor",
  "testCompaction",
  "testReplyInterpreter",
  "override",
] as const;

describe("#305 AC6: the unit runners of agboss/testing", () => {
  it.each(UNIT_RUNNERS)("%s is exported as a function", (name) => {
    expect(typeof testing[name]).toBe("function");
  });

  it.each(REMOVED_RUNNERS)("%s is gone", (name) => {
    expect(testing).not.toHaveProperty(name);
  });
});
