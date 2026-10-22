import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { describeApplication } from "../../src/describe/describe-application.js";
import { ItemsWorkflow, StepCapApplication } from "../app/fixtures/step-slots.workflow.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";

/**
 * #332 AC5 — `agboss describe` says the instance's cap on steps: `maxConcurrentSteps 4 (set)`, and
 * that there is none when the application sets none; `describe --json` carries it as data.
 */

@Application({
  name: "uncapped-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ItemsWorkflow],
  budgets: TEST_BUDGETS,
})
class UncappedApplication {}

describe("#332 AC5: describe prints maxConcurrentSteps", () => {
  it("a capped application: its cap, as set, as text and as data", async () => {
    const assembled = await applicationOf(StepCapApplication);

    expect(describeApplication(assembled)).toContain(
      "maxConcurrentSteps 4 (set) · agent, router and action steps of this instance at work at once",
    );
    expect(describedApplicationOf(assembled).maxConcurrentSteps).toBe(4);
  });

  it("an application without a cap says so", async () => {
    const assembled = await applicationOf(UncappedApplication);

    expect(describeApplication(assembled)).toContain(
      "maxConcurrentSteps none (not set) · no cap on this instance's steps",
    );
    expect(describedApplicationOf(assembled)).not.toHaveProperty("maxConcurrentSteps");
  });
});
