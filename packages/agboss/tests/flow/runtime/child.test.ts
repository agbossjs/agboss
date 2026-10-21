import { describe, expect } from "vitest";
import { ChildExecutionStatus } from "../../../src/index.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import {
  CompanyFinderAgent,
  CompanyPickerAgent,
  CompanyRejectedWorkflowFinish,
  CompanyReviewApplication,
  CompanyReviewerAgent,
  CompanyReviewWorkflow,
  CompanyReviewWorkflowStart,
  CompanyScreeningWorkflowStart,
  DeepDiveAgent,
  GradedShortlistWorkflowFinish,
  GraderAgent,
  JobOfferAgent,
  JobOfferWorkflowFinish,
  JobOfferWorkflowStart,
  NoOfferRejectedWorkflowFinish,
  ReviewRankerAgent,
} from "../fixtures/children.fixture.js";
import {
  CompanyGradeDto,
  CompanyRejectedDto,
  DeepDiveDto,
  GradedShortlistDto,
  JobOfferDto,
  PromisingCompanyDto,
} from "../fixtures/child-dtos.js";
import { CompanyDto } from "../fixtures/data-dtos.js";

/** #263 PR 2 — a child workflow as a step: AC1, AC5, AC6, AC14 (the nested record). */

const test = testWith(CompanyReviewApplication);

const rejected = replyWith(CompanyRejectedDto, { reason: "too small" });

describe("AC1: a child runs alone and as a step, with the same output", () => {
  test("same output alone and as a step", async ({ app, mockLlm }) => {
    mockLlm(CompanyReviewerAgent).thenReturn(rejected, rejected);
    mockLlm(CompanyPickerAgent).thenReturn(replyWith(CompanyDto, { name: "Acme" }));

    const alone = await app.execute(CompanyReviewWorkflowStart, { name: "Acme" });
    const asStep = await app.execute(JobOfferWorkflowStart, { text: "an offer for Acme" });

    expect(alone).toFinishWith(CompanyRejectedWorkflowFinish, { reason: "too small" });
    expect(asStep).toFinishWith(NoOfferRejectedWorkflowFinish, { reason: "too small" });
    expect(asStep.path).toEqual([
      "job-offer-workflow-start",
      "company-picker-agent",
      "company-review-workflow",
      "no-offer-rejected-workflow-finish",
    ]);
  });

  test("the switch after the child takes the case of its finish's class", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(CompanyPickerAgent).thenReturn(replyWith(CompanyDto, { name: "Acme" }));
    mockLlm(CompanyReviewerAgent).thenReturn(replyWith(PromisingCompanyDto, { reason: "growing" }));
    mockLlm(DeepDiveAgent).thenReturn(replyWith(DeepDiveDto, { findings: "solid" }));
    mockLlm(GraderAgent).thenReturn(replyWith(CompanyGradeDto, { grade: "A" }));
    mockLlm(JobOfferAgent).thenReturn(replyWith(JobOfferDto, { text: "join Acme" }));

    const result = await app.execute(JobOfferWorkflowStart, { text: "an offer for Acme" });

    expect(result).toFinishWith(JobOfferWorkflowFinish, { text: "join Acme" });
    const asked = JSON.stringify(mockLlm(JobOfferAgent).requests[0]?.input);
    expect(asked).toContain("company-review-workflow");
  });
});

describe("AC14: a nested record", () => {
  test("nested record, inheritance, not in history", async ({ app, mockLlm }) => {
    mockLlm(CompanyPickerAgent).thenReturn(replyWith(CompanyDto, { name: "Acme" }));
    mockLlm(CompanyReviewerAgent).thenReturn(rejected);

    const result = await app.execute(JobOfferWorkflowStart, { text: "an offer for Acme" });

    expect(result.children).toMatchObject([
      {
        parentExecutionId: result.executionId,
        rootExecutionId: result.executionId,
        workflow: { name: "company-review-workflow", version: "1.0.0" },
        launchedBy: { nodeId: "company-review-workflow", visitNumber: 1 },
        start: { name: "company-review-workflow-start" },
        input: { name: "Acme" },
        status: ChildExecutionStatus.Finished,
        finish: { name: "company-rejected-workflow-finish" },
        output: { reason: "too small" },
        path: [
          "company-review-workflow-start",
          "company-reviewer-agent",
          "company-rejected-workflow-finish",
        ],
        children: [],
      },
    ]);
    const [child] = result.children;
    expect(child?.executionId).not.toBe(result.executionId);
    expect(child?.itemIndex).toBeUndefined();
  });
});

describe("AC5 / AC6: one child per item", () => {
  test("one child per item, the join's list in item order", async ({ app, mockLlm }) => {
    const names = ["Acme", "Globex", "Initech"];
    mockLlm(CompanyFinderAgent).thenReturn(
      replyWith(
        CompanyDto,
        names.map((name) => ({ name })),
      ),
    );
    mockLlm(CompanyReviewerAgent).thenReturnAlways(rejected);
    mockLlm(ReviewRankerAgent).thenReturn(replyWith(GradedShortlistDto, { order: "none" }));

    const result = await app.execute(CompanyScreeningWorkflowStart, { text: "tea makers" });

    expect(result).toFinishWith(GradedShortlistWorkflowFinish, { order: "none" });
    expect(result.children.map((child) => child.itemIndex).sort()).toEqual([0, 1, 2]);
    expect(
      [...result.children]
        .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
        .map((c) => c.input),
    ).toEqual(names.map((name) => ({ name })));
    const ranked = JSON.stringify(mockLlm(ReviewRankerAgent).requests[0]?.input);
    expect(ranked).toContain("too small");
    expect(result.launches[0]?.branches).toHaveLength(3);
    expect(result).toFollowPath([
      CompanyScreeningWorkflowStart,
      CompanyFinderAgent,
      CompanyReviewWorkflow,
      CompanyReviewWorkflow,
      CompanyReviewWorkflow,
      ReviewRankerAgent,
      GradedShortlistWorkflowFinish,
    ]);
  });

  test("a child's graded result reaches the ranker", async ({ app, mockLlm }) => {
    mockLlm(CompanyFinderAgent).thenReturn(replyWith(CompanyDto, [{ name: "Acme" }]));
    mockLlm(CompanyReviewerAgent).thenReturn(replyWith(PromisingCompanyDto, { reason: "growing" }));
    mockLlm(DeepDiveAgent).thenReturn(replyWith(DeepDiveDto, { findings: "solid" }));
    mockLlm(GraderAgent).thenReturn(replyWith(CompanyGradeDto, { grade: "A" }));
    mockLlm(ReviewRankerAgent).thenReturn(replyWith(GradedShortlistDto, { order: "Acme" }));

    const result = await app.execute(CompanyScreeningWorkflowStart, { text: "tea makers" });

    expect(result).toFinishWith(GradedShortlistWorkflowFinish, { order: "Acme" });
    expect(result.children[0]?.finish).toEqual({ name: "company-graded-workflow-finish" });
  });
});
