import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { loadWorkflowClass } from "../../src/loader/load-workflow.js";
import { TestWorkflow } from "../fixtures/test-workflow/test.workflow.js";

const fixture = (name: string): string => new URL(`../fixtures/${name}`, import.meta.url).pathname;
// vitest already transpiles TypeScript; the CLI registers tsx itself
const options = { typescript: false } as const;

describe("workflow loader (agboss <command> --workflow <path>)", () => {
  it("AC3: loads the one exported @Workflow class of a module file", async () => {
    expect((await loadWorkflowClass(fixture("test-workflow/test.workflow.ts"), options)).name).toBe(
      "TestWorkflow",
    );
  });

  it("AC3: a missing file, no @Workflow export or several are clear errors naming the file", async () => {
    await expect(loadWorkflowClass(fixture("nope.ts"), options)).rejects.toThrow(
      /Workflow file not found: .*nope\.ts/,
    );
    await expect(loadWorkflowClass(fixture("loader/none.workflow.ts"), options)).rejects.toThrow(
      /none\.workflow\.ts: expected exactly one exported @Workflow class, found 0/,
    );
    await expect(
      loadWorkflowClass(fixture("loader/two.workflow.ts"), options),
    ).rejects.toBeInstanceOf(ConfigError.WorkflowLoad);
  });
});
