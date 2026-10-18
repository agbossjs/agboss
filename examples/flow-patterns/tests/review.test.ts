import { describe, expect } from "vitest";
import { failWith, ModelFailure, replyWith, testWith, type ModelRequest } from "agboss/testing";
import { FactCheckerAgent } from "../src/review/agents/fact-checker.agent.js";
import { SectionReviewerAgent } from "../src/review/agents/section-reviewer.agent.js";
import { SectionSplitterAgent } from "../src/review/agents/section-splitter.agent.js";
import { StyleCriticAgent } from "../src/review/agents/style-critic.agent.js";
import { FactCheckDto } from "../src/review/dtos/fact-check.dto.js";
import { SectionReviewDto } from "../src/review/dtos/section-review.dto.js";
import { SectionDto } from "../src/review/dtos/section.dto.js";
import { StyleNotesDto } from "../src/review/dtos/style-notes.dto.js";
import { FlowPatternsApplication } from "../src/flow-patterns.application.js";
import { ReviewIncompleteWorkflowFinish } from "../src/review/workflow-finishes/review-incomplete.workflow-finish.js";
import { ReviewWorkflowFinish } from "../src/review/workflow-finishes/review.workflow-finish.js";
import { ReviewWorkflowStart } from "../src/review/workflow-starts/review.workflow-start.js";

/** Parallel launches in waves (#273): a reviewer per section, then the critics side by side. */

const test = testWith(FlowPatternsApplication);

const sections = (...titles: readonly string[]) =>
  replyWith(
    SectionDto,
    titles.map((title) => ({ title, text: `${title} text` })),
  );

/** Each reviewer repeats its section's title; only "Method" needs work. */
const reviewer = (request: ModelRequest) => {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  const title = /"title": "([^"]+)"/.exec(input)?.[1] ?? "?";
  return replyWith(SectionReviewDto, { title, ready: title !== "Method", notes: "checked" });
};

describe("a reviewer per section, then the critics side by side", () => {
  test("each join gives the next step its values; copies of one agent give a list", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(SectionSplitterAgent).thenReturn(sections("Intro", "Method", "Results"));
    mockLlm(SectionReviewerAgent).thenAnswer(reviewer);
    mockLlm(StyleCriticAgent).thenReturn(replyWith(StyleNotesDto, { notes: "shorter" }));
    mockLlm(FactCheckerAgent).thenReturn(
      replyWith(FactCheckDto, { claim: "the sample size" }),
      replyWith(FactCheckDto, { claim: "none" }),
    );

    const result = await app.execute(ReviewWorkflowStart, { text: "the manuscript" });

    expect(result).toFinishWith(ReviewWorkflowFinish, {
      rework: "Method",
      style: "shorter",
      claims: 1,
    });
    expect(result.path).toEqual([
      "review-workflow-start",
      "section-splitter-agent",
      "section-reviewer-agent",
      "section-reviewer-agent",
      "section-reviewer-agent",
      "editorial-plan-action",
      "style-critic-agent",
      "fact-checker-agent#1",
      "fact-checker-agent#2",
      "review-workflow-finish",
    ]);
    expect(result.launches).toMatchObject([
      { items: 3, taken: 3 },
      { items: 3, taken: 3 },
    ]);
  });

  test("more sections than maxItems: the first 20 are reviewed, without an error", async ({
    app,
    mockLlm,
  }) => {
    const titles = Array.from({ length: 22 }, (_, index) => `Part ${String(index + 1)}`);
    mockLlm(SectionSplitterAgent).thenReturn(sections(...titles));
    mockLlm(SectionReviewerAgent).thenAnswer(reviewer);
    mockLlm(StyleCriticAgent).thenReturn(replyWith(StyleNotesDto, { notes: "fine" }));
    mockLlm(FactCheckerAgent).thenReturnAlways(replyWith(FactCheckDto, { claim: "none" }));

    const result = await app.execute(ReviewWorkflowStart, { text: "a long manuscript" });

    expect(result).toFinishWith(ReviewWorkflowFinish);
    expect(result.launches[0]).toMatchObject({ items: 22, taken: 20 });
    expect(mockLlm(SectionReviewerAgent).requests).toHaveLength(20);
  });

  test("a critic that fails takes .onJoinError(StepFailedError, …): the plan, unreviewed", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(SectionSplitterAgent).thenReturn(sections("Intro", "Method"));
    mockLlm(SectionReviewerAgent).thenAnswer(reviewer);
    mockLlm(StyleCriticAgent).thenReturn(replyWith(StyleNotesDto, { notes: "shorter" }));
    mockLlm(FactCheckerAgent).thenReturnAlways(failWith(ModelFailure.Timeout));

    const result = await app.execute(ReviewWorkflowStart, { text: "the manuscript" });

    expect(result).toFinishWith(ReviewIncompleteWorkflowFinish, {
      rework: "Method",
      ready: "Intro",
    });
  });
});
