import { describe, expect, it } from "vitest";
import { WorkflowSettings, type WorkflowDefinition } from "../../src/graph/settings.js";
import { minutes, seconds, UnitError, usd } from "../../src/units/index.js";
import type { IncompatibleResumePolicy } from "../../src/run/resume-guard.js";

describe("AC1: workflow settings and units", () => {
  const policy: IncompatibleResumePolicy = () => "resume";

  class TestWorkflow implements WorkflowDefinition {
    settings(): WorkflowSettings {
      return WorkflowSettings.builder().onIncompatibleResume(policy).build();
    }
  }

  it("settings() returns what the builder set; money is not among them (#261: @Budget)", () => {
    expect(new TestWorkflow().settings().onIncompatibleResume).toBe(policy);
    expect(WorkflowSettings.builder().build().onIncompatibleResume).toBeUndefined();
    expect(WorkflowSettings.builder()).not.toHaveProperty("limits");
  });

  it("usd, seconds and minutes carry checked amounts", () => {
    expect([usd(0.5), seconds(2), minutes(1)]).toEqual([0.5, 2000, 60_000]);
    expect(() => usd(-1)).toThrow(UnitError);
    expect(() => seconds(Number.NaN)).toThrow(UnitError);
  });
});
