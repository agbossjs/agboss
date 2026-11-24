/**
 * #1324: `@agboss/core/describe` — the public entry takes the `@Application` class and assembles it
 * itself, so a caller needs no `AssembledApplication`: the text, one workflow's text and the data.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import {
  describeApplication,
  describeApplicationData,
  describeWorkflow,
} from "../../src/describe/index.js";
import {
  Agent,
  EmptyEnvironment,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../src/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";

@Agent({
  name: "greeter-agent",
  description: "Greets",
  prompt: inline("Greet."),
  model: "test/greeter",
})
class GreeterAgent {}

@WorkflowStart({ name: "greet-workflow-start", description: "Ask", input: WorkflowStartTextDto })
class GreetWorkflowStart {}

@WorkflowFinish({
  name: "greet-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
class GreetWorkflowFinish {}

@Workflow({
  name: "greet-workflow",
  version: "1.0.0",
  flow: [onStart(GreetWorkflowStart).toAgent(GreeterAgent).toFinish(GreetWorkflowFinish)],
})
class GreetWorkflow {}

@Workflow({
  name: "other-workflow",
  version: "1.0.0",
  flow: [onStart(GreetWorkflowStart).toAgent(GreeterAgent).toFinish(GreetWorkflowFinish)],
})
class OtherWorkflow {}

@Application({
  name: "greet-application",
  version: "2.0.0",
  environment: EmptyEnvironment,
  workflows: [GreetWorkflow],
  budgets: TEST_BUDGETS,
})
class GreetApplication {}

describe("#1324: describe from the application class", () => {
  it("describeApplication: the application's text, with the source in its header", async () => {
    const lines = await describeApplication(GreetApplication, { source: "src/app.ts" });

    expect(lines[0]).toBe("greet-application 2.0.0 (src/app.ts)");
    expect(lines.some((line) => line.startsWith("greet-workflow 1.0.0 · config "))).toBe(true);
    expect(lines.some((line) => line.includes("greeter-agent"))).toBe(true);
  });

  it("describeWorkflow: one workflow of the application, without the application's lines", async () => {
    const lines = await describeWorkflow(GreetApplication, GreetWorkflow);

    expect(lines[0]).toMatch(/^greet-workflow 1\.0\.0 · config /);
    expect(lines).not.toContain("greet-application 2.0.0");
  });

  it("describeWorkflow: a workflow the application does not run is an error", async () => {
    await expect(describeWorkflow(GreetApplication, OtherWorkflow)).rejects.toThrow(
      /OtherWorkflow is not a workflow of greet-application/,
    );
  });

  it("describeApplicationData: the typed projection — application and workflows", async () => {
    const data = await describeApplicationData(GreetApplication);

    expect(data.application).toMatchObject({
      name: "greet-application",
      version: "2.0.0",
      workflows: ["greet-workflow"],
      maxConcurrentSteps: null,
    });
    expect(data.application.tree.map((node) => node.name)).toEqual(["greet-workflow"]);
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0]).toMatchObject({
      name: "greet-workflow",
      profile: "base",
      unassignedTools: [],
    });
    expect(data.workflows[0]?.agents.map((agent) => agent.name)).toEqual(["greeter-agent"]);
  });

  it("the profile of the options labels the data and an unknown profile fails", async () => {
    await expect(describeApplicationData(GreetApplication, { profile: "nope" })).rejects.toThrow();
  });

  it("a class that is no @Application is refused with the function's name", async () => {
    await expect(describeApplication(GreetWorkflow)).rejects.toThrow(/describeApplication/);
  });
});
