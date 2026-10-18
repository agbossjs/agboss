import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { OutdatedReason } from "../../../src/index.js";
import { callTool, replyWith, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto } from "../fixtures/dtos.js";
import { ApprovalDto, DraftDto, ResearchDto } from "../fixtures/review-dtos.js";
import {
  AskEditorTool,
  LoopPublisherAgent,
  LoopResearcherAgent,
  LoopReviewerAgent,
  LoopWorkflowFinish,
  LoopWorkflowStart,
  LoopWriterAgent,
  outdatingEvents,
  resetOutdatingLog,
  LoopApplication,
} from "./fixtures/outdating.workflow.js";

/**
 * #271 AC11 (rule 12): a pause in the middle of the review loop, a restart of the process and a
 * resume — provenance and the outdated values come back from the checkpoint, and the outdating
 * goes on from them.
 */

const loop = testWith(LoopApplication);
const approve = { approved: true, by: "dana" };

beforeEach(resetOutdatingLog);

describe("#271 AC11: outdating across a pause", () => {
  loop(
    "pause mid-cycle: provenance and outdated marks restored",
    async ({ app, recoverApp, mockLlm }) => {
      mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "f" }));
      mockLlm(LoopWriterAgent).thenReturn(
        replyWith(DraftDto, { text: "v1" }),
        replyWith(DraftDto, { text: "v2" }),
        replyWith(DraftDto, { text: "v3" }),
      );
      mockLlm(LoopReviewerAgent).thenReturn(
        replyWith(DraftChangesDto, { changes: "first notes" }),
        callTool(AskEditorTool, { text: "is v2 fine?" }),
        replyWith(DraftChangesDto, { changes: "second notes" }),
        replyWith(ApprovalDto, { reason: "good" }),
      );
      mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "v3, published" }));

      const paused = await execute(app, LoopWorkflowStart, { topic: "t" });
      const eventsBeforePause = outdatingEvents.length;
      const restarted = await recoverApp();
      const done = await restarted.resume(paused.thread, approve, { record: true });

      expect(paused.status).toBe(ExecutionStatus.Paused);
      expect(eventsBeforePause).toBe(1);
      expect(done).toFinishWith(LoopWorkflowFinish, { body: "v3, published" });
      expect(done.record?.outdatedValues.map((value) => [value.valueId, value.outdated])).toEqual([
        [
          "loop-writer-agent:1/DraftDto",
          { byValueId: "loop-writer-agent:2/DraftDto", reason: OutdatedReason.Replaced },
        ],
        [
          "loop-reviewer-agent:1/DraftChangesDto",
          { byValueId: "loop-writer-agent:2/DraftDto", reason: OutdatedReason.AboutReplaced },
        ],
        [
          "loop-writer-agent:2/DraftDto",
          { byValueId: "loop-writer-agent:3/DraftDto", reason: OutdatedReason.Replaced },
        ],
        [
          "loop-reviewer-agent:2/DraftChangesDto",
          { byValueId: "loop-writer-agent:3/DraftDto", reason: OutdatedReason.AboutReplaced },
        ],
      ]);
      const changes = done.record?.outdatedValues.find(
        (value) => value.valueId === "loop-reviewer-agent:2/DraftChangesDto",
      );
      expect(changes?.builtFrom).toEqual(["loop-writer-agent:2/DraftDto"]);
      const publisher = mockLlm(LoopPublisherAgent).onlyRequest;
      expect(publisher.kind === "chat" && publisher.input).not.toMatch(/"v1"|"v2"/);
    },
  );
});
