/**
 * #497 — `workflowOf(W)` finds W's application next to its file. When that file comes from outside
 * the test's module graph (installed from npm without `agbossTest()`: Node imports it, without
 * decorators, or in a second graph), it throws `TestSetupError` naming the fix instead of an obscure
 * syntax error or a workflow silently assembled without its application. Here the failures are
 * real: an application file whose import throws, and one listing another class of W's name.
 */
import { describe, expect, it } from "vitest";
import { TestSetupError, workflowOf } from "../../src/testing/index.js";
import { applicationsListing } from "../../src/application/application.js";
import { AloneProbeWorkflow } from "../fixtures/outside-graph/alone/alone.workflow.js";
import { BrokenProbeWorkflow } from "../fixtures/outside-graph/broken/broken.workflow.js";
import { FoundProbeWorkflow } from "../fixtures/outside-graph/found/found.workflow.js";
import { TwinProbeWorkflow } from "../fixtures/outside-graph/twin/twin.workflow.js";

const outsideGraph = (workflow: string): string =>
  `the application of ${workflow} was loaded outside vitest's module graph; use agbossTest() from @agboss/core/testing/vitest in vitest.config.ts`;

describe("AC4: workflowOf names the vitest preset when the application is outside the graph", () => {
  it("AC4: an application file that fails to import is a TestSetupError, its error the cause", async () => {
    const failure = workflowOf(BrokenProbeWorkflow);

    await expect(failure).rejects.toThrow(TestSetupError);
    await expect(failure).rejects.toThrow(outsideGraph("broken-probe-workflow"));
    await expect(failure).rejects.toMatchObject({
      cause: { message: "broken.application.ts cannot be loaded" },
    });
  });

  it("AC4: an application listing another class of the workflow's name is a TestSetupError", async () => {
    const failure = workflowOf(TwinProbeWorkflow);

    await expect(failure).rejects.toThrow(TestSetupError);
    await expect(failure).rejects.toThrow(outsideGraph("twin-probe-workflow"));
    await expect(failure).rejects.toSatisfy((error: Error) => !("cause" in error));
  });
});

describe("AC1: workflowOf in the test's graph assembles the workflow in its application", () => {
  it("AC1: the application next to the workflow is loaded and gives its defaults", async () => {
    const assembled = await workflowOf(FoundProbeWorkflow);

    expect(assembled.config.defaults.models).toEqual({ temperature: 0.25 });
    expect(applicationsListing(FoundProbeWorkflow)).toHaveLength(1);
  });

  it("AC1: an application loaded already is used again, nothing looked for twice", async () => {
    await workflowOf(FoundProbeWorkflow);
    const assembled = await workflowOf(FoundProbeWorkflow);

    expect(assembled.config.defaults.models).toEqual({ temperature: 0.25 });
    expect(applicationsListing(FoundProbeWorkflow)).toHaveLength(1);
  });

  it("AC1: a workflow no application lists is assembled on its own, no error", async () => {
    const assembled = await workflowOf(AloneProbeWorkflow);

    expect(assembled.config.name).toBe("alone-probe-workflow");
    expect(assembled.config.defaults.models).toEqual({ temperature: 0 });
  });

  it("AC1: on the providers given nothing is looked for near the file", async () => {
    const assembled = await workflowOf(BrokenProbeWorkflow, []);

    expect(assembled.config.name).toBe("broken-probe-workflow");
  });

  it("AC1: a class no decorator declared fails as before, nothing looked for near a file", async () => {
    class NotAWorkflow {
      readonly kind = "plain";
    }

    await expect(workflowOf(NotAWorkflow)).rejects.not.toThrow(TestSetupError);
  });
});
