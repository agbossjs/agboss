import { describe, expect } from "vitest";
import { testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { VendorCheckerAgent } from "../../../../src/vendor/agents/vendor-checker/vendor-checker.agent.js";
import { VendorCheckWorkflowStart } from "../../../../src/vendor/workflows/vendor-check/vendor-check.workflow-start.js";
import { VendorScoredWorkflowFinish } from "../../../../src/vendor/workflows/vendor-check/vendor-scored.workflow-finish.js";
import { checker } from "../support/vendor-checker.js";

/** The child of vendor-screening-workflow (#263), run on its own. */

const test = testWith(FlowPatternsApplication);

describe("a child workflow per vendor", () => {
  test("the child runs alone with the same result", async ({ app, mockLlm }) => {
    mockLlm(VendorCheckerAgent).thenAnswer(checker);

    const result = await app.execute(VendorCheckWorkflowStart, { name: "Acme" });

    expect(result).toFinishWith(VendorScoredWorkflowFinish, { name: "Acme", score: 8 });
    expect(result.children).toEqual([]);
  });
});
