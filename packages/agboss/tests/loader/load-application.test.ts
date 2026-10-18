import { describe, expect, it } from "vitest";
import { loadApplicationClass } from "../../src/loader/load-application.js";
import { WorkflowLoadError } from "../../src/loader/load-workflow.js";
import { ChatApplication } from "../flow/fixtures/chat.fixture.js";
import { SoloApplication } from "../fixtures/loader/apps/solo.application.js";

/**
 * #261 PR 2: the CLI's bridge until #268 — the `@Application` that runs a `--workflow` file: one in
 * the workflow's own module, else a `*.application.ts` of its folder or a folder above it.
 */

const fixture = (name: string): string => new URL(`../${name}`, import.meta.url).pathname;
// vitest already transpiles TypeScript; the CLI registers tsx itself
const options = { typescript: false } as const;

describe("#261: the application of a --workflow file", () => {
  it("the application exported next to the workflow, in its own module", async () => {
    const found = await loadApplicationClass(fixture("flow/fixtures/chat.fixture.ts"), options);

    expect(found).toBe(ChatApplication);
  });

  it("a *.application.ts in a folder above the workflow's", async () => {
    const found = await loadApplicationClass(
      fixture("fixtures/loader/apps/solo/solo.workflow.ts"),
      options,
    );

    expect(found).toBe(SoloApplication);
  });

  it("no application lists the workflow: an error saying where to add one", async () => {
    const loading = loadApplicationClass(
      fixture("fixtures/loader/orphan/orphan.workflow.ts"),
      options,
    );

    await expect(loading).rejects.toBeInstanceOf(WorkflowLoadError);
    await expect(loading).rejects.toThrow(
      "no exported @Application lists SupportWorkflow — add one in a *.application.ts file next to it",
    );
  });
});
