import { describe, expect } from "vitest";
import {
  failWith,
  ModelFailure,
  replyWith,
  testWith,
  type ModelRequest,
} from "@agboss/core/testing";
import { VendorCheckerAgent } from "../src/vendor/agents/vendor-checker/vendor-checker.agent.js";
import { VendorFinderAgent } from "../src/vendor/agents/vendor-finder/vendor-finder.agent.js";
import { VendorRankerAgent } from "../src/vendor/agents/vendor-ranker/vendor-ranker.agent.js";
import { VendorRankingDto } from "../src/vendor/dto/vendor-ranking.dto.js";
import { VendorRejectedDto } from "../src/vendor/dto/vendor-rejected.dto.js";
import { VendorScoreDto } from "../src/vendor/dto/vendor-score.dto.js";
import { VendorDto } from "../src/vendor/dto/vendor.dto.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { VendorCheckWorkflow } from "../src/vendor/workflows/vendor-check/vendor-check.workflow.js";
import { VendorCheckFailedWorkflowFinish } from "../src/vendor/workflows/vendor-check/vendor-check-failed.workflow-finish.js";
import { VendorRankingWorkflowFinish } from "../src/vendor/workflows/vendor-screening/vendor-ranking.workflow-finish.js";
import { VendorRejectedWorkflowFinish } from "../src/vendor/workflows/vendor-check/vendor-rejected.workflow-finish.js";
import { VendorScoredWorkflowFinish } from "../src/vendor/workflows/vendor-check/vendor-scored.workflow-finish.js";
import { VendorCheckWorkflowStart } from "../src/vendor/workflows/vendor-check/vendor-check.workflow-start.js";
import { VendorScreeningWorkflowStart } from "../src/vendor/workflows/vendor-screening/vendor-screening.workflow-start.js";

/** A child workflow per item (#263): each vendor checked in an execution of its own. */

const test = testWith(FlowPatternsApplication);

const vendors = (...names: readonly string[]) =>
  replyWith(
    VendorDto,
    names.map((name) => ({ name })),
  );

/** "Acme" scores, "Initech" is not a fit, "Globex"'s check fails (its model times out). */
const checker = (request: ModelRequest) => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  if (input.includes("Globex")) return failWith(ModelFailure.Timeout);
  return input.includes("Acme")
    ? replyWith(VendorScoreDto, { name: "Acme", score: 8 })
    : replyWith(VendorRejectedDto, { name: "Initech", reason: "too small" });
};

describe("a child workflow per vendor", () => {
  test("each vendor its own child; the ranker gets every result, a failed one too", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(VendorFinderAgent).thenReturn(vendors("Acme", "Globex", "Initech"));
    mockLlm(VendorCheckerAgent).thenAnswer(checker);
    mockLlm(VendorRankerAgent).thenReturn(
      replyWith(VendorRankingDto, { order: "Acme", leftOut: "Globex, Initech" }),
    );

    const result = await app.execute(VendorScreeningWorkflowStart, { text: "packaging" });

    expect(result).toFinishWith(VendorRankingWorkflowFinish, {
      order: "Acme",
      leftOut: "Globex, Initech",
    });
    expect(result).toHaveChildExecutions(VendorCheckWorkflow, [
      { item: { name: "Acme" }, finish: VendorScoredWorkflowFinish },
      { item: { name: "Globex" }, finish: VendorCheckFailedWorkflowFinish },
      { item: { name: "Initech" }, finish: VendorRejectedWorkflowFinish },
    ]);
    const ranked = JSON.stringify(mockLlm(VendorRankerAgent).requests[0]?.input);
    expect(ranked).toContain("the check failed");
    expect(ranked).toContain("too small");
  });

  test("the child runs alone with the same result", async ({ app, mockLlm }) => {
    mockLlm(VendorCheckerAgent).thenAnswer(checker);

    const result = await app.execute(VendorCheckWorkflowStart, { name: "Acme" });

    expect(result).toFinishWith(VendorScoredWorkflowFinish, { name: "Acme", score: 8 });
    expect(result.children).toEqual([]);
  });
});
