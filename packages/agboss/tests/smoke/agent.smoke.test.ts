import { workflowOf } from "../../src/testing/index.js";
import { TestWorkflow } from "../fixtures/test-workflow/test.workflow.js";
import { describe, expect, it } from "vitest";
import { createAppDeps } from "../../src/app/app-deps.js";
import { executeAgent } from "../../src/index.js";
import { textRequestOf } from "../../src/flow/runtime/start-input.js";

// Real models via OpenRouter. Only via `make smoke`, skipped without a key. Never in CI.
describe.skipIf(!process.env.OPENROUTER_API_KEY)("smoke: real models", () => {
  it("routes a simple task and stays within budget", async () => {
    const deps = await createAppDeps(await workflowOf(TestWorkflow));
    const request = textRequestOf(deps.graph, "What is 2+2? Reply with the number only.");
    const result = await executeAgent(request, deps).finally(() => deps.close());

    expect(JSON.stringify(result.output)).toContain("4");
    expect(result.cost.totalUsd).toBeLessThan(0.05);
  });
});
