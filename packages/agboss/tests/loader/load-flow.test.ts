import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { loadFlowProject } from "../../src/loader/load-flow.js";
import { PartsWorkflow } from "../flow/fixtures/wide.fixture.js";

/** The v2 loader of type generation (#272 S2): the workflows and the modules they came from. */

const fixture = (name: string): string => new URL(`../${name}`, import.meta.url).pathname;
// vitest already transpiles TypeScript; the CLI registers tsx itself
const options = { typescript: false } as const;

describe("S2: loading v2 workflows and their modules", () => {
  it("the v2 workflows a module exports, and the module with its named exports", async () => {
    const file = fixture("flow/fixtures/wide.fixture.ts");

    const project = await loadFlowProject([file], options);

    expect(project.workflows).toEqual([PartsWorkflow]);
    expect(project.modules.map((module) => module.file)).toEqual([file]);
    expect(project.modules[0]?.exports.PartsWorkflow).toBe(PartsWorkflow);
  });

  it("the files the components were declared in are modules too", async () => {
    const project = await loadFlowProject([fixture("flow/fixtures/broken.fixture.ts")], options);

    expect(project.modules.map((module) => module.file)).toEqual([
      fixture("flow/fixtures/broken.fixture.ts"),
      fixture("flow/fixtures/offer.fixture.ts"),
    ]);
  });

  it("a module without a @Workflow holds no workflow", async () => {
    const project = await loadFlowProject([fixture("fixtures/loader/none.workflow.ts")], options);

    expect(project.workflows).toEqual([]);
  });

  it("a missing file is a ConfigError.WorkflowLoad naming it", async () => {
    await expect(loadFlowProject([fixture("nope.ts")], options)).rejects.toThrow(
      ConfigError.WorkflowLoad,
    );
  });
});
