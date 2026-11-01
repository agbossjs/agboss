// The files check-packed.mjs adds to the project `agboss create packed-probe` writes (#497).

export const PROJECT = "packed-probe";

/** What `workflowOf` throws when the application is loaded outside vitest's module graph. */
export const OUTSIDE_GRAPH =
  "was loaded outside vitest's module graph; use agbossTest() from @agboss/core/testing/vitest in vitest.config.ts";

/**
 * AC1: `workflowOf` finds the application next to the workflow and assembles the workflow in it — its
 * own model provider, not the built-in one. The file imports no application and no setup file loads
 * one: `workflowOf` has to load it itself. (AC5, `testWith` and the environments: the project's own
 * workflow test.)
 */
export const WORKFLOW_OF_TEST = `import { workflowOf } from "@agboss/core/testing";
import { expect, test } from "vitest";
import { OpenRouterModelProvider } from "../../src/model-providers/openrouter.model-provider.js";
import { PackedProbeWorkflow } from "../../src/workflows/packed-probe/packed-probe.workflow.js";

test("workflowOf assembles the workflow in its application, from the installed package", async () => {
  const assembled = await workflowOf(PackedProbeWorkflow);

  expect(assembled.config.name).toBe("packed-probe-workflow");
  expect(assembled.modelProviders).toContain(OpenRouterModelProvider);
});
`;

export const WORKFLOW_OF_TEST_FILE = "tests/packed/workflow-of.test.ts";

/** AC4: the form before #497 — the matchers registered, AGBoss left external to vitest. */
export const PLAIN_VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/**/*.test.ts"], setupFiles: ["@agboss/core/testing/setup"] },
});
`;

/** #645 AC2: a test that fails inside the core — its stack trace must name lines of the package. */
export const CORE_FAILURE_TEST = `import { usd } from "@agboss/core/units";
import { test } from "vitest";

test("a failure inside the core", () => {
  usd(-1);
});
`;

export const CORE_FAILURE_TEST_FILE = "tests/packed/core-failure.test.ts";
