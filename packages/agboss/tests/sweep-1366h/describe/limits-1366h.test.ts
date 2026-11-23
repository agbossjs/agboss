/**
 * #1366: the limits section of `describe` — the depth of a recursive workflow, an unbounded step range as a lower bound,
 * and the nodes' visit caps are shown when the workflow has them and left out when it has none.
 */
import { describe, expect, it } from "vitest";
import { describedLimitsOf, limitLines, worstCaseLimitsOf } from "../../../src/describe/limits.js";
import { workflowOf } from "../../../src/testing/workflow-of.js";
import { DeepResearchWorkflow } from "../../flow/fixtures/recursion.fixture.js";
import { StoryWorkflow } from "../../flow/fixtures/review.fixture.js";
import { TestWorkflow } from "../../fixtures/test-workflow/test.workflow.js";
import { CodeReview } from "../../testing/fixtures/code-review.workflow.js";

const recursive = await workflowOf(DeepResearchWorkflow);
const story = await workflowOf(StoryWorkflow);
const review = await workflowOf(CodeReview);
const plain = await workflowOf(TestWorkflow);

describe("#1366: limit lines", () => {
  it("a recursive workflow shows its maxDepth in the data and as a line", () => {
    expect(describedLimitsOf(recursive).maxDepth).toBe(4);
    expect(limitLines(recursive)).toContain(
      "  maxDepth 4 · levels of the workflow launching itself",
    );
  });

  it("a workflow that does not launch itself has no maxDepth, in data or text", () => {
    expect("maxDepth" in describedLimitsOf(plain)).toBe(false);
    expect(limitLines(plain).some((l) => l.includes("maxDepth"))).toBe(false);
  });

  it("an unbounded step range reads as its least with a plus, a bounded one as least to most", () => {
    expect(limitLines(story)[1]).toMatch(/ · steps 4\+$/);
    expect(limitLines(review)[1]).toMatch(/ · steps 3\+$/);
    expect(limitLines(recursive)[1]).toMatch(/ · steps 1–2$/);
  });

  it("the nodes' visit caps are listed on one line, joined by commas", () => {
    expect(limitLines(story)).toContain("  maxVisits story-reviewer-agent 4, story-writer-agent 4");
    expect(limitLines(review)).toContain("  maxVisits review-gate-router 3");
  });

  it("a workflow whose nodes have no visit cap lists no maxVisits line", () => {
    expect(Object.keys(describedLimitsOf(recursive).maxVisits)).toEqual([]);
    expect(limitLines(recursive).some((l) => l.includes("maxVisits"))).toBe(false);
  });

  it("a workflow with no visit cap and no depth goes from its steps straight to the next section", () => {
    expect(limitLines(plain)[0]).toBe("limits");
    expect(limitLines(recursive)[2]).toMatch(/^ {2}maxDepth 4/);
  });

  it("the worst-case limits carry a depth only when there is one", () => {
    expect(worstCaseLimitsOf(describedLimitsOf(plain))).toStrictEqual({
      maxConcurrentExecutions: describedLimitsOf(plain).maxConcurrentExecutions,
    });
    expect(worstCaseLimitsOf(describedLimitsOf(recursive)).maxDepth).toBe(4);
  });
});
