import { describe, expect, it } from "vitest";
import { WorkflowSettings, type WorkflowDefinition } from "../../src/graph/settings.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import { ResumeDecision, type IncompatibleResumePolicy } from "../../src/run/resume-guard.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

describe("AC1: workflow settings and units", () => {
  const policy: IncompatibleResumePolicy = () => ResumeDecision.Resume;

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
    expect(() => usd(-1)).toThrow(ConfigError.Unit);
    expect(() => seconds(Number.NaN)).toThrow(ConfigError.Unit);
  });
});
