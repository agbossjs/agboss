import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto } from "../fixtures/dtos.js";
import { ApprovalDto, DraftDto, ResearchDto } from "../fixtures/review-dtos.js";
import {
  LoopPublisherAgent,
  LoopResearcherAgent,
  LoopReviewerAgent,
  LoopWorkflowStart,
  LoopWriterAgent,
  LoopApplication,
} from "./fixtures/outdating.workflow.js";

/**
 * #271 AC8 (rule 9): an agent with a typed input never sees an outdated value — not in its input
 * message, not in the thread's history (finished executions' start and finish only, #272 S8), not
 * in what it said on an earlier visit.
 */

const loop = testWith(LoopApplication);

const everything = (request: unknown): string => JSON.stringify(request);

describe("#271 AC8: history never holds an outdated value", () => {
  loop(
    "an agent never sees an outdated draft, in this execution or the one before",
    async ({ app, mockLlm }) => {
      mockLlm(LoopResearcherAgent).thenReturn(
        replyWith(ResearchDto, { facts: "f1" }),
        replyWith(ResearchDto, { facts: "f2" }),
      );
      mockLlm(LoopWriterAgent).thenReturn(
        replyWith(DraftDto, { text: "first-run draft" }),
        replyWith(DraftDto, { text: "old draft" }),
        replyWith(DraftDto, { text: "new draft" }),
      );
      mockLlm(LoopReviewerAgent).thenReturn(
        replyWith(ApprovalDto, { reason: "ok" }),
        replyWith(DraftChangesDto, { changes: "rewrite it" }),
        replyWith(ApprovalDto, { reason: "ok now" }),
      );
      mockLlm(LoopPublisherAgent).thenReturn(
        replyWith(ArticleDto, { body: "article one" }),
        replyWith(ArticleDto, { body: "article two" }),
      );

      const first = await execute(app, LoopWorkflowStart, { topic: "one" });
      await execute(app, LoopWorkflowStart, { topic: "two" }, { thread: first.thread });

      const [, , lastReview] = mockLlm(LoopReviewerAgent).requests;
      const lastWrite = mockLlm(LoopWriterAgent).lastRequest;
      const publish = mockLlm(LoopPublisherAgent).lastRequest;
      for (const request of [lastReview, lastWrite, publish]) {
        expect(everything(request)).not.toContain("old draft");
        expect(everything(request)).not.toContain("first-run draft");
      }
      expect(everything(publish)).toContain("article one");
      expect(everything(publish)).toContain("new draft");
    },
  );
});
