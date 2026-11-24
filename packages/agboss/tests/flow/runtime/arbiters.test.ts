import { beforeEach, describe, expect } from "vitest";
import { ArbiterError, BranchStatus, BranchVerdict } from "../../../src/index.js";
import {
  decideWith,
  failWith,
  ModelFailure,
  replyWith,
  testWith,
  type ModelRequest,
  TestConcurrency,
} from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { ScoreDto, ScoreReviewDto } from "../fixtures/quorum-dtos.js";
import {
  HirePanelAgent,
  HybridPanelArbiter,
  panel,
  PanelFailedWorkflowFinish,
  PanelItemsWorkflowStart,
  PanelChatArbiter,
  PanelModelArbiter,
  PanelReviewWorkflowFinish,
  PanelSummaryAgent,
  PanelUnjudgedWorkflowFinish,
  PanelWorkflowStart,
  resetPanel,
  textOf,
  RisksPanelAgent,
  SkillsPanelAgent,
} from "../fixtures/quorum-runtime-parts.js";
import {
  ChatPanelApplication,
  CheckedPanelApplication,
  CopiesPanelApplication,
  EachItemPanelApplication,
  HybridPanelApplication,
  ItemPanelApplication,
  ModelPanelApplication,
  ArbitratedPanelApplication,
  StrictPanelApplication,
} from "../fixtures/quorum-runtime.fixture.js";

/**
 * #279 PR 2 — arbiters at run time (AC5, AC6, AC12, S57): a model arbiter judges each answer by its
 * agent's criterion; a code arbiter by its `@Arbitrate` method, the copy and the item from
 * `ExecutionContext`; a hybrid arbiter asks its own model only for what its code cannot decide; a
 * check still running when the quorum is decided does not count; an arbiter
 * that fails is `ArbiterError`, never a rejection.
 */

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const REAL = { concurrency: TestConcurrency.Real };
const model = testWith(ModelPanelApplication, REAL);
const checked = testWith(CheckedPanelApplication, REAL);
const hybrid = testWith(HybridPanelApplication, REAL);
const arbitrated = testWith(ArbitratedPanelApplication, REAL);
const eachItem = testWith(EachItemPanelApplication, REAL);
const items = testWith(ItemPanelApplication, REAL);
const copies = testWith(CopiesPanelApplication, REAL);
const strict = testWith(StrictPanelApplication, REAL);
const chat = testWith(ChatPanelApplication, REAL);

const score = (value: number) => replyWith(ScoreDto, { score: value });
const summary = replyWith(ScoreReviewDto, { text: "summed up" });
const ANNA = { name: "Anna" };

/** The criterion a model arbiter's decision asked about. */
const criterionOf = (request: ModelRequest | undefined): unknown =>
  request?.kind === "decide" ? request.questions.counts?.instructions : undefined;

/** P(yes) by the agent whose answer the decision is about. */
const judgeBy =
  (yes: Readonly<Record<string, number>>) =>
  (request: ModelRequest): ReturnType<typeof decideWith> => {
    const input = typeof request.input === "string" ? request.input : "";
    const agent = Object.keys(yes).find((name) => input.includes(`(from ${name})`)) ?? "";
    return decideWith({ counts: yes[agent] ?? 0 });
  };

beforeEach(resetPanel);

describe("AC5: a model arbiter judges each answer by its agent's criterion", () => {
  model(
    "one decision per answer: the criterion of the agent that gave it",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelModelArbiter).thenAnswer(
        judgeBy({ "skills-panel-agent": 0.2, "risks-panel-agent": 0.9, "hire-panel-agent": 0.8 }),
      );
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect(result.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Rejected, rejectedBy: ["panel-model-arbiter"] },
        { verdict: BranchVerdict.Counted },
        { verdict: BranchVerdict.Counted },
      ]);
      const asked = mockLlm(PanelModelArbiter).requests;
      expect(asked.map(criterionOf).sort()).toEqual([
        "Ends with a clear hire / no hire",
        "Names a concrete risk",
        "Scores the technical skills",
      ]);
      expect(asked[0]?.input).toContain("Count an answer only if it meets the criterion");
      expect(result.spend.byCaller).toHaveProperty("arbiter:panel-model-arbiter");
    },
  );

  model("its model does not answer: ArbiterError, taken by .onError", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturn(score(7));
    mockLlm(RisksPanelAgent).thenReturn(score(6));
    mockLlm(HirePanelAgent).thenReturn(score(9));
    mockLlm(PanelModelArbiter).thenReturnAlways(failWith(ModelFailure.Timeout));

    const result = await execute(app, PanelWorkflowStart, ANNA, { includeRecord: true });

    expect(result).toFinishWith(PanelUnjudgedWorkflowFinish, ANNA);
    expect(result.record?.lastError).toMatchObject({
      code: "step.arbiter",
      lineage: ["step.arbiter", "step.failed", "step", "agboss"],
      details: { arbiter: "panel-model-arbiter" },
    });
  });
});

describe("AC5: a model arbiter on a chat model", () => {
  chat("it answers through its answer tool, a boolean per answer", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturn(score(7));
    mockLlm(RisksPanelAgent).thenReturn(score(6));
    mockLlm(HirePanelAgent).thenReturn(score(9));
    mockLlm(PanelChatArbiter).thenAnswer(
      judgeBy({ "skills-panel-agent": 0.9, "risks-panel-agent": 0.1, "hire-panel-agent": 0.8 }),
    );
    mockLlm(PanelSummaryAgent).thenReturn(summary);

    const result = await execute(app, PanelWorkflowStart, ANNA);

    expect(result.launches[0]?.branches).toMatchObject([
      { verdict: BranchVerdict.Counted },
      { verdict: BranchVerdict.Rejected, rejectedBy: ["panel-chat-arbiter"] },
      { verdict: BranchVerdict.Counted },
    ]);
    expect(mockLlm(PanelChatArbiter).requests).toHaveLength(3);
  });
});

describe("AC6: a code arbiter, the copy and the item from ExecutionContext", () => {
  items("per item: its method sees the item's index", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturnAlways(score(5));
    mockLlm(PanelSummaryAgent).thenReturn(summary);
    const five = ["a", "b", "c", "d", "e"].map((name) => ({ name }));

    const result = await execute(app, PanelItemsWorkflowStart, five);

    expect(result).toFinishWith(PanelReviewWorkflowFinish);
    expect([...panel.checks].sort()).toEqual([
      "even-item skills-panel-agent[0] 5",
      "even-item skills-panel-agent[1] 5",
      "even-item skills-panel-agent[2] 5",
      "even-item skills-panel-agent[3] 5",
      "even-item skills-panel-agent[4] 5",
    ]);
    const verdicts = result.launches[0]?.branches.map((branch) => branch.verdict);
    expect(verdicts).toEqual([
      BranchVerdict.Counted,
      BranchVerdict.Rejected,
      BranchVerdict.Counted,
      BranchVerdict.Rejected,
      BranchVerdict.Counted,
    ]);
  });

  copies(
    "copies: one method for every copy, the copy number tells them apart",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturnAlways(score(5));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect([...panel.checks].sort()).toEqual([
        "copy skills-panel-agent#1 1",
        "copy skills-panel-agent#2 2",
        "copy skills-panel-agent#3 3",
      ]);
      expect(result.launches[0]?.branches).toMatchObject([
        { nodeId: "skills-panel-agent#1", verdict: BranchVerdict.Counted },
        { nodeId: "skills-panel-agent#2", verdict: BranchVerdict.Rejected },
        { nodeId: "skills-panel-agent#3", verdict: BranchVerdict.Counted },
      ]);
    },
  );

  checked("a method that throws: ArbiterError, never a rejection", async ({ app, mockLlm }) => {
    mockLlm(SkillsPanelAgent).thenReturn(score(13));
    mockLlm(RisksPanelAgent).thenReturn(score(6));
    mockLlm(HirePanelAgent).thenReturn(score(9));

    const result = await execute(app, PanelWorkflowStart, ANNA, { includeRecord: true });

    expect(result).toFinishWith(PanelUnjudgedWorkflowFinish, ANNA);
    expect(result.record?.lastError).toMatchObject({
      code: "step.arbiter",
      message: expect.stringContaining("thirteen is not a score") as unknown,
      details: { arbiter: "in-range-arbiter", nodeId: "skills-panel-agent" },
    });
    expect(result.launches[0]?.branches[0]).toMatchObject({
      status: BranchStatus.Failed,
      error: { code: "step.arbiter" },
    });
    expect(ArbiterError.code).toBe("step.arbiter");
  });
});

describe("AC12: one arbiter per launch — hybrid, inParallel, forEachItem, cancelled at max", () => {
  hybrid(
    "a hybrid arbiter decides at $0 what its code can and asks its own model for the rest (#1283)",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(9)); // clear: counted by code
      mockLlm(RisksPanelAgent).thenReturn(score(6)); // borderline: its model is asked
      mockLlm(HirePanelAgent).thenReturn(score(2)); // clear: rejected by code
      mockLlm(HybridPanelArbiter).thenReturn(decideWith({ acceptable: 0.9 }, { cost: usd(0.002) }));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect(result.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Counted },
        { verdict: BranchVerdict.Counted },
        { verdict: BranchVerdict.Rejected, rejectedBy: ["hybrid-panel-arbiter"] },
      ]);
      expect(mockLlm(HybridPanelArbiter).requests).toHaveLength(1);
      expect(result.spend.byCaller["arbiter:hybrid-panel-arbiter"]).toBe(0.002);
    },
  );

  hybrid(
    "a hybrid arbiter that fails after its model call is ArbiterError, and the call's spend is in the ledger (#1399)",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(5)); // asks its model, then throws
      mockLlm(RisksPanelAgent).thenReturn(score(9));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(HybridPanelArbiter).thenReturn(decideWith({ acceptable: 0.9 }, { cost: usd(0.002) }));

      const result = await execute(app, PanelWorkflowStart, ANNA, { includeRecord: true });

      expect(result).toFinishWith(PanelUnjudgedWorkflowFinish, ANNA);
      expect(result.record?.lastError).toMatchObject({
        code: "step.arbiter",
        details: { arbiter: "hybrid-panel-arbiter" },
      });
      expect(result.spend.byCaller["arbiter:hybrid-panel-arbiter"]).toBe(0.002);
    },
  );

  arbitrated(
    ".inParallel([…]) takes .arbitratedBy(A) and a quorum, as .inParallel does (#1282)",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(11));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect(result.launches[0]?.branches).toMatchObject([
        { verdict: BranchVerdict.Rejected, rejectedBy: ["in-range-arbiter"] },
        { verdict: BranchVerdict.Counted },
        { verdict: BranchVerdict.Counted },
      ]);
    },
  );

  arbitrated(
    "an .inParallel([…]) quorum no arbiter lets reach min is not reached",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(0));
      mockLlm(RisksPanelAgent).thenReturn(score(11));
      mockLlm(HirePanelAgent).thenReturn(score(9));

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelFailedWorkflowFinish, ANNA);
    },
  );

  eachItem(
    ".forEachItem(…) takes .arbitratedBy(A) and .joinQuorum(…): the arbiter reads the item (#1282)",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturnAlways(score(5));
      mockLlm(PanelSummaryAgent).thenReturn(summary);
      const six = ["a", "b", "c", "d", "e", "f"].map((name) => ({ name }));

      const result = await execute(app, PanelItemsWorkflowStart, six);

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      // the launch took the first five items; only the even ones (0, 2, 4) count
      const verdicts = result.launches[0]?.branches.map((branch) => branch.verdict);
      expect(verdicts).toEqual([
        BranchVerdict.Counted,
        BranchVerdict.Rejected,
        BranchVerdict.Counted,
        BranchVerdict.Rejected,
        BranchVerdict.Counted,
      ]);
    },
  );

  strict(
    "a check still running when max is taken is cancelled; its answer does not count",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(99)); // its check waits for a gate never opened
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelReviewWorkflowFinish);
      expect(result.launches[0]?.branches).toMatchObject([
        { nodeId: "skills-panel-agent", status: BranchStatus.Cancelled },
        { verdict: BranchVerdict.Counted },
        { verdict: BranchVerdict.Counted },
      ]);
      expect(result.launches[0]?.branches[0]?.verdict).toBeUndefined();
      expect(mockLlm(PanelSummaryAgent).requests[0]?.input).not.toContain('"score": 99');
    },
  );

  checked(
    "the quorum unreachable after rejections: the failed finish",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(0));
      mockLlm(RisksPanelAgent).thenReturn(score(11));
      mockLlm(HirePanelAgent).thenReturn(score(9));

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result).toFinishWith(PanelFailedWorkflowFinish, ANNA);
    },
  );
});
