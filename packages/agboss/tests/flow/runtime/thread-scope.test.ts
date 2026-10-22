import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto } from "../fixtures/dtos.js";
import { ApprovalDto, DraftDto, ResearchDto } from "../fixtures/review-dtos.js";
import {
  LoopApplication,
  LoopPublisherAgent,
  LoopResearcherAgent,
  LoopReviewerAgent,
  LoopWorkflowStart,
  LoopWriterAgent,
} from "./fixtures/outdating.workflow.js";

/**
 * #336 AC1 — a regression test, no behaviour change: every `app.execute` is an execution of its own
 * (its id is its checkpoint's thread), so a second execution on a thread whose first one finished
 * starts with an empty scope and no outdated values — only the thread's history carries over.
 */

const loop = testWith(LoopApplication);

describe("#336 AC1: a second execution on one thread", () => {
  loop("starts with an empty scope; only history carries over", async ({ app, mockLlm }) => {
    mockLlm(LoopResearcherAgent).thenReturn(
      replyWith(ResearchDto, { facts: "first facts" }),
      replyWith(ResearchDto, { facts: "second facts" }),
    );
    mockLlm(LoopWriterAgent).thenReturn(
      replyWith(DraftDto, { text: "first draft" }),
      replyWith(DraftDto, { text: "first draft, shorter" }),
      replyWith(DraftDto, { text: "second draft" }),
    );
    mockLlm(LoopReviewerAgent).thenReturn(
      replyWith(DraftChangesDto, { changes: "shorter" }),
      replyWith(ApprovalDto, { reason: "good" }),
      replyWith(ApprovalDto, { reason: "fine" }),
    );
    mockLlm(LoopPublisherAgent).thenReturn(
      replyWith(ArticleDto, { body: "one" }),
      replyWith(ArticleDto, { body: "two" }),
    );

    // the first execution goes round the review loop: it leaves outdated values and visit 2s
    const first = await execute(app, LoopWorkflowStart, { topic: "alpha" }, { record: true });
    const second = await execute(
      app,
      LoopWorkflowStart,
      { topic: "beta" },
      { threadId: first.threadId, record: true },
    );

    expect(first.record?.outdatedValues).not.toEqual([]);
    expect(second.threadId).toBe(first.threadId);
    expect(second.executionId).not.toBe(first.executionId);
    // the scope is the second execution's own: first visits, its own values, nothing outdated
    expect(second.record?.outdatedValues).toEqual([]);
    expect(second.record?.scope.map((value) => value.valueId)).toEqual([
      "loop-workflow-start:1/ArticleRequestDto",
      "loop-researcher-agent:1/ResearchDto",
      "loop-writer-agent:1/DraftDto",
      "loop-reviewer-agent:1/ApprovalDto",
      "loop-publisher-agent:1/ArticleDto",
    ]);
    expect(second.record?.scope.map((value) => value.value)).toEqual([
      { topic: "beta" },
      { facts: "second facts" },
      { text: "second draft" },
      { reason: "fine" },
      { body: "two" },
    ]);
    // no step of the second execution reads a value of the first
    const writer = mockLlm(LoopWriterAgent).lastRequest;
    expect(writer.kind === "chat" && writer.input).toContain("second facts");
    expect(writer.kind === "chat" && writer.input).not.toContain("first");
    // the thread's history does: the first turn is in what the researcher's model reads
    const research = mockLlm(LoopResearcherAgent).lastRequest;
    const history = research.kind === "chat" ? JSON.stringify(research.messages) : "";
    expect(history).toContain("alpha");
    expect(history).not.toContain("first draft, shorter");
  });
});
