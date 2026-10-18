import { beforeEach, describe, expect } from "vitest";
import { OutdatedReason } from "../../../src/index.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import { DraftChangesDto } from "../fixtures/data-dtos.js";
import { ArticleDto } from "../fixtures/dtos.js";
import {
  ApprovalDto,
  CandidateProfileDto,
  DraftDto,
  JobListDto,
  JobPickDto,
  JobScoresDto,
  ResearchDto,
} from "../fixtures/review-dtos.js";
import {
  AdviceAgent,
  AdviceDto,
  JobsRouter,
  JobsWorkflowFinish,
  JobsWorkflowStart,
  LoopPublisherAgent,
  LoopResearcherAgent,
  LoopReviewerAgent,
  LoopWorkflowFinish,
  LoopWorkflowStart,
  LoopWriterAgent,
  PickAgent,
  ProfileAgent,
  ScoreAgent,
  SearchAgent,
  resetOutdatingLog,
  JobsApplication,
  LoopApplication,
} from "./fixtures/outdating.workflow.js";
import {
  DoneFinish,
  DraftDto as EditDraftDto,
  EditStart,
  EditorAgent,
  GateRouter,
  EditApplication,
} from "./fixtures/edit.workflow.js";

/**
 * #271 PR 2 — outdating at run time (AC1, AC3, AC12): `scope` holds current values only, each with
 * what it was built from; a write moves what it makes stale to `outdatedValues`, with the root
 * trigger and the reason; nothing outdated reaches an input, a prompt or a finish.
 */

const loop = testWith(LoopApplication);
const jobs = testWith(JobsApplication);
const edit = testWith(EditApplication);

beforeEach(resetOutdatingLog);

const ROUNDS = 5;
const drafts = Array.from({ length: ROUNDS + 1 }, (_, round) => `draft v${String(round + 1)}`);

describe("#271 AC1/AC3: the review loop at run time", () => {
  loop(
    "builtFrom per kind: input fields, the about target, never the notes about the old draft",
    async ({ app, mockLlm }) => {
      mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "f" }));
      mockLlm(LoopWriterAgent).thenReturn(
        replyWith(DraftDto, { text: "v1" }),
        replyWith(DraftDto, { text: "v2" }),
      );
      mockLlm(LoopReviewerAgent).thenReturn(
        replyWith(DraftChangesDto, { changes: "shorter" }),
        replyWith(ApprovalDto, { reason: "good" }),
      );
      mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "v2, published" }));

      const result = await execute(app, LoopWorkflowStart, { topic: "t" }, { record: true });

      const builtFrom = Object.fromEntries(
        (result.record?.scope ?? []).map((value) => [value.valueId, value.builtFrom]),
      );
      expect(builtFrom).toEqual({
        "loop-workflow-start:1/ArticleRequestDto": [],
        "loop-researcher-agent:1/ResearchDto": ["loop-workflow-start:1/ArticleRequestDto"],
        "loop-writer-agent:2/DraftDto": [
          "loop-researcher-agent:1/ResearchDto",
          "loop-workflow-start:1/ArticleRequestDto",
        ],
        "loop-reviewer-agent:2/ApprovalDto": ["loop-writer-agent:2/DraftDto"],
        "loop-publisher-agent:1/ArticleDto": [
          "loop-reviewer-agent:2/ApprovalDto",
          "loop-writer-agent:2/DraftDto",
        ],
      });
    },
  );

  loop(
    "outdated in record, never in input: the old draft and its notes leave the scope with reasons",
    async ({ app, mockLlm }) => {
      mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "f" }));
      mockLlm(LoopWriterAgent).thenReturn(
        replyWith(DraftDto, { text: "v1" }),
        replyWith(DraftDto, { text: "v2" }),
      );
      mockLlm(LoopReviewerAgent).thenReturn(
        replyWith(DraftChangesDto, { changes: "shorter" }),
        replyWith(ApprovalDto, { reason: "good" }),
      );
      mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "v2, published" }));

      const result = await execute(app, LoopWorkflowStart, { topic: "t" }, { record: true });

      expect(result.record?.outdatedValues).toEqual([
        expect.objectContaining({
          valueId: "loop-writer-agent:1/DraftDto",
          value: { text: "v1" },
          outdated: { byValueId: "loop-writer-agent:2/DraftDto", reason: OutdatedReason.Replaced },
        }),
        expect.objectContaining({
          valueId: "loop-reviewer-agent:1/DraftChangesDto",
          value: { changes: "shorter" },
          outdated: {
            byValueId: "loop-writer-agent:2/DraftDto",
            reason: OutdatedReason.AboutReplaced,
          },
        }),
      ]);
      expect(result.record?.scope.map((value) => value.slot).sort()).toEqual([
        "ApprovalDto",
        "ArticleDto",
        "ArticleRequestDto",
        "DraftDto",
        "ResearchDto",
      ]);
      const publisher = mockLlm(LoopPublisherAgent).onlyRequest;
      expect(publisher.kind === "chat" && publisher.input).not.toContain('"v1"');
      expect(result).toFinishWith(LoopWorkflowFinish, { body: "v2, published" });
    },
  );

  loop(
    `a loop of ${String(ROUNDS)} rounds: after each, one current draft and only values about it`,
    async ({ app, mockLlm }) => {
      mockLlm(LoopResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "f" }));
      mockLlm(LoopWriterAgent).thenReturn(...drafts.map((text) => replyWith(DraftDto, { text })));
      mockLlm(LoopReviewerAgent).thenReturn(
        ...drafts
          .slice(0, ROUNDS)
          .map((_, round) => replyWith(DraftChangesDto, { changes: `notes ${String(round + 1)}` })),
        replyWith(ApprovalDto, { reason: "good" }),
      );
      mockLlm(LoopPublisherAgent).thenReturn(replyWith(ArticleDto, { body: "published" }));

      const result = await execute(app, LoopWorkflowStart, { topic: "t" }, { record: true });

      const reviews = mockLlm(LoopReviewerAgent).requests;
      expect(
        reviews.map((request) =>
          drafts.filter(
            (text) => request.kind === "chat" && JSON.stringify(request.input).includes(text),
          ),
        ),
      ).toEqual(drafts.map((text) => [text]));
      const writes = mockLlm(LoopWriterAgent).requests.slice(1);
      expect(
        writes.map((request) =>
          [1, 2, 3, 4, 5].filter(
            (round) =>
              request.kind === "chat" &&
              JSON.stringify(request.input).includes(`notes ${String(round)}`),
          ),
        ),
      ).toEqual([[1], [2], [3], [4], [5]]);
      const outdated = result.record?.outdatedValues ?? [];
      expect(outdated.filter((value) => value.slot === "DraftDto")).toHaveLength(ROUNDS);
      expect(outdated.filter((value) => value.slot === "DraftChangesDto")).toHaveLength(ROUNDS);
      const current = result.record?.scope.find((value) => value.slot === "DraftDto");
      expect(current?.value).toEqual({ text: drafts.at(-1) });
    },
  );

  loop(
    "a second execution on the thread starts with its start input only",
    async ({ app, mockLlm }) => {
      mockLlm(LoopResearcherAgent).thenReturn(
        replyWith(ResearchDto, { facts: "first" }),
        replyWith(ResearchDto, { facts: "second" }),
      );
      mockLlm(LoopWriterAgent).thenReturn(
        replyWith(DraftDto, { text: "first draft" }),
        replyWith(DraftDto, { text: "second draft" }),
      );
      mockLlm(LoopReviewerAgent).thenReturn(
        replyWith(ApprovalDto, { reason: "ok" }),
        replyWith(ApprovalDto, { reason: "ok" }),
      );
      mockLlm(LoopPublisherAgent).thenReturn(
        replyWith(ArticleDto, { body: "one" }),
        replyWith(ArticleDto, { body: "two" }),
      );

      const first = await execute(app, LoopWorkflowStart, { topic: "one" });
      const second = await execute(
        app,
        LoopWorkflowStart,
        { topic: "two" },
        { thread: first.thread, record: true },
      );

      expect(second.thread).toBe(first.thread);
      expect(second.record?.outdatedValues).toEqual([]);
      expect(second.record?.scope.map((value) => value.value)).not.toContainEqual({
        text: "first draft",
      });
      const research = mockLlm(LoopResearcherAgent).lastRequest;
      expect(research.kind === "chat" && research.input).toContain('"two"');
      expect(research.kind === "chat" && research.input).not.toContain('"one"');
    },
  );
});

describe("#271 AC1/AC3: outdating without a cycle — the jobs for an old profile", () => {
  jobs(
    "a new profile outdates the jobs, their scores and the pick: a chain of three levels, one root",
    async ({ app, mockLlm }) => {
      mockLlm(ProfileAgent).thenReturn(
        replyWith(CandidateProfileDto, { summary: "junior" }),
        replyWith(CandidateProfileDto, { summary: "senior" }),
      );
      mockLlm(SearchAgent).thenReturn(
        replyWith(JobListDto, { jobs: "junior jobs" }),
        replyWith(JobListDto, { jobs: "senior jobs" }),
      );
      mockLlm(ScoreAgent).thenReturn(
        replyWith(JobScoresDto, { scores: "junior scores" }),
        replyWith(JobScoresDto, { scores: "senior scores" }),
      );
      mockLlm(AdviceAgent).thenReturn(
        replyWith(AdviceDto, { advice: "junior advice" }),
        replyWith(AdviceDto, { advice: "senior advice" }),
      );
      mockLlm(PickAgent).thenReturn(
        replyWith(JobPickDto, { job: "junior pick" }),
        replyWith(JobPickDto, { job: "senior pick" }),
      );
      mockLlm(JobsRouter).thenReturn(routeTo(ProfileAgent), routeTo(JobsWorkflowFinish));

      const result = await execute(app, JobsWorkflowStart, { text: "me" }, { record: true });

      const root = "profile-agent:2/CandidateProfileDto";
      expect(result.record?.outdatedValues.map((value) => [value.valueId, value.outdated])).toEqual(
        [
          [
            "profile-agent:1/CandidateProfileDto",
            { byValueId: root, reason: OutdatedReason.Replaced },
          ],
          [
            "advice-agent:1/AdviceDto",
            { byValueId: root, reason: OutdatedReason.BuiltFromReplaced },
          ],
          [
            "pick-agent:1/JobPickDto",
            { byValueId: root, reason: OutdatedReason.BuiltFromReplaced },
          ],
          [
            "score-agent:1/JobScoresDto",
            { byValueId: root, reason: OutdatedReason.BuiltFromReplaced },
          ],
          [
            "search-agent:1/JobListDto",
            { byValueId: root, reason: OutdatedReason.BuiltFromReplaced },
          ],
        ],
      );
      expect(result).toFinishWith(JobsWorkflowFinish, { job: "senior pick" });
      const pick = mockLlm(PickAgent).lastRequest;
      expect(pick.kind === "chat" && pick.input).not.toContain("junior");
    },
  );

  jobs(
    "an agent without input is built from every current value before it (rule 8)",
    async ({ app, mockLlm }) => {
      mockLlm(ProfileAgent).thenReturn(replyWith(CandidateProfileDto, { summary: "s" }));
      mockLlm(SearchAgent).thenReturn(replyWith(JobListDto, { jobs: "j" }));
      mockLlm(ScoreAgent).thenReturn(replyWith(JobScoresDto, { scores: "sc" }));
      mockLlm(AdviceAgent).thenReturn(replyWith(AdviceDto, { advice: "a" }));
      mockLlm(PickAgent).thenReturn(replyWith(JobPickDto, { job: "p" }));
      mockLlm(JobsRouter).thenReturn(routeTo(JobsWorkflowFinish));

      const result = await execute(app, JobsWorkflowStart, { text: "me" }, { record: true });

      const advice = result.record?.scope.find((value) => value.slot === "AdviceDto");
      expect(advice?.builtFrom).toEqual([
        "jobs-workflow-start:1/WorkflowStartTextDto",
        "profile-agent:1/CandidateProfileDto",
        "score-agent:1/JobScoresDto",
        "search-agent:1/JobListDto",
      ]);
    },
  );
});

describe("#271 S40 (c): the record shows the live sources only", () => {
  edit(
    "a value that read a source its own write outdated: that source is absent from its builtFrom",
    async ({ app, mockLlm }) => {
      mockLlm(EditorAgent).thenReturn(
        replyWith(EditDraftDto, { text: "v1" }),
        replyWith(EditDraftDto, { text: "v2" }),
      );
      mockLlm(GateRouter).thenReturn(routeTo(EditorAgent), routeTo(DoneFinish));

      const result = await execute(app, EditStart, { text: "write" }, { record: true });

      const draft = result.record?.scope.find((value) => value.slot === "DraftDto");
      expect(draft?.valueId).toBe("editor-agent:2/DraftDto");
      expect(draft?.builtFrom).toEqual(["edit-workflow-start:1/WorkflowStartTextDto"]);
      const request = mockLlm(EditorAgent).lastRequest;
      expect(request.kind === "chat" && request.input).toContain('"v1"');
      expect(result.record?.outdatedValues.map((value) => value.valueId)).toEqual([
        "editor-agent:1/DraftDto",
      ]);
    },
  );
});
