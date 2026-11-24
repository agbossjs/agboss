/** #1328b: `testWith(App, { only })` assembles the listed workflows and the children they launch. */
import { describe, expect, it } from "vitest";
import { TestEnvironment } from "../../src/testing/environment.js";
import { TestSetupError, testWith } from "../../src/testing/index.js";
import { OpenWorkflow, PiiApplication } from "../pii/pii.fixture.js";

describe("#1328b: testWith({ only })", () => {
  const only = testWith(PiiApplication, { only: [OpenWorkflow] });

  only("the application has just the listed workflow", async ({ app }) => {
    expect(Object.keys(app.settings)).toEqual(["open-workflow"]);
  });

  const all = testWith(PiiApplication);

  all("without only every workflow is assembled", async ({ app }) => {
    expect(Object.keys(app.settings).sort()).toEqual(["open-workflow", "pii-workflow"]);
  });

  it("a class that is not a workflow of the application is a setup error", async () => {
    class Stranger {
      readonly note = "not a workflow";
    }

    await expect(TestEnvironment.of(PiiApplication, { only: [Stranger] })).rejects.toThrow(
      TestSetupError,
    );
  });
});
