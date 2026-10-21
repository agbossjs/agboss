import { beforeEach, describe, expect } from "vitest";
import { BranchStatus } from "../../../src/index.js";
import { replyWith, testWith, TestConcurrency } from "../../../src/testing/index.js";
import { execute } from "../../helpers/flow.js";
import {
  CheckoutWorkflowStart,
  PaymentWorkflowFinish,
  ArticleDraftWorkflowFinish,
  ArticleWriterAgent,
  CriticAgent,
  PlannerAgent,
  PlanResearcherAgent,
  ResearchWorkflowStart,
} from "../fixtures/launch.fixture.js";
import { ArticleDraftDto } from "../fixtures/launch-dtos.js";
import { CritiqueDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";
import { CheckoutApplication, ResearchApplication } from "./fixtures/launch.applications.js";
import {
  CritiquesWorkflowFinish,
  LoopCriticAgent,
  LoopPlannerAgent,
  PlanLoopApplication,
  PlanLoopWorkflowStart,
  TiredApplication,
  TiredCriticAgent,
  TiredPlannerAgent,
  TiredWorkflowFinish,
  TiredWorkflowStart,
} from "./fixtures/launch-runs.workflow.js";
import {
  CopiesApplication,
  ItemResultDto,
  ItemsFailedWorkflowFinish,
  FanOutApplication,
  FanOutUnboundedApplication,
  fanOut,
  ItemsWorkflowStart,
  OneItemWorkflowStart,
  resetFanOut,
  StampsWorkflowFinish,
  SummaryWorkflowFinish,
  type ItemDto,
} from "./fixtures/fan-out.workflow.js";

/** These tests are about the runtime's own concurrency (#262: tests default to one branch at a time). */
const REAL = { concurrency: TestConcurrency.Real };
const research = testWith(ResearchApplication, REAL);

describe("AC1: different agents, a repeated one", () => {
  research("repeated agent — two copies, listOf after join, copy ids", async ({ app, mockLlm }) => {
    mockLlm(PlannerAgent).thenReturn(replyWith(PlanDto, { outline: "intro, body" }));
    mockLlm(PlanResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "three facts" }));
    mockLlm(CriticAgent).thenReturn(
      replyWith(CritiqueDto, { remark: "too long" }),
      replyWith(CritiqueDto, { remark: "no sources" }),
    );
    mockLlm(ArticleWriterAgent).thenReturn(replyWith(ArticleDraftDto, { text: "the article" }));

    const result = await app.execute(ResearchWorkflowStart, { text: "write about tea" });

    expect(result.path).toEqual([
      "research-workflow-start",
      "planner-agent",
      "plan-researcher-agent",
      "critic-agent#1",
      "critic-agent#2",
      "article-writer-agent",
      "article-draft-workflow-finish",
    ]);
    expect(result).toFinishWith(ArticleDraftWorkflowFinish, { text: "the article" });
    expect(mockLlm(ArticleWriterAgent).requests[0]?.input).toContain("too long");
  });
});

const items = testWith(FanOutApplication, REAL);
const unbounded = testWith(FanOutUnboundedApplication, REAL);
const copies = testWith(CopiesApplication, REAL);
const checkout = testWith(CheckoutApplication, REAL);

const item = (name: string, delay = 0): ItemDto => ({ name, delay, outcome: "ok" });
const SAME_ITEMS = [item("a", 10), item("b", 0), item("c", 5)];

beforeEach(resetFanOut);

describe("AC1: copies of one target", () => {
  copies(
    "each copy has its own id, copy number and visit; the join lists both",
    async ({ app }) => {
      const result = await execute(app, OneItemWorkflowStart, item("x"));

      expect(result.path).toEqual([
        "one-item-workflow-start",
        "stamp-action#1",
        "stamp-action#2",
        "stamps-workflow-finish",
      ]);
      expect(result).toFinishWith(StampsWorkflowFinish, {
        text: "stamp-action#1 1 1; stamp-action#2 2 1",
      });
      expect(result.launches[0]?.branches).toEqual([
        { nodeId: "stamp-action#1", copyNumber: 1, status: BranchStatus.Finished },
        { nodeId: "stamp-action#2", copyNumber: 2, status: BranchStatus.Finished },
      ]);
    },
  );
});

describe("AC3: maxConcurrency", () => {
  items("at most n in progress — sliding window", async ({ app }) => {
    await execute(app, ItemsWorkflowStart, [
      item("a", 80),
      item("b", 5),
      item("c", 5),
      item("d", 5),
    ]);

    expect(fanOut.mostInFlight).toBe(2);
    // c and d start as b and c end, while a still runs: no waves
    expect(fanOut.events.indexOf("start c")).toBeGreaterThan(fanOut.events.indexOf("end b"));
    expect(fanOut.events.indexOf("start d")).toBeLessThan(fanOut.events.indexOf("end a"));
  });

  items("same result for any n — two at a time", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, SAME_ITEMS);

    expect(fanOut.mostInFlight).toBe(2);
    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c" });
  });

  unbounded("same result for any n — all at once", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, SAME_ITEMS);

    expect(fanOut.mostInFlight).toBe(3);
    expect(result).toFinishWith(SummaryWorkflowFinish, { text: "a, b, c" });
  });
});

describe("AC9: parallel actions", () => {
  checkout(
    "parallel actions: each runs once, the finish reads the payment from the path",
    async ({ app }) => {
      const result = await app.execute(CheckoutWorkflowStart, { text: "pay-1" });

      expect(result).toFinishWith(PaymentWorkflowFinish, { paymentId: "pay-1", amount: 1 });
      expect(result.path).toEqual([
        "checkout-workflow-start",
        "charge-payment-action",
        "send-receipt-action",
        "update-crm-action",
        "reserve-goods-action",
        "payment-workflow-finish",
      ]);
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
        BranchStatus.Finished,
        BranchStatus.Finished,
        BranchStatus.Finished,
      ]);
    },
  );
});

const loop = testWith(PlanLoopApplication, REAL);
const tired = testWith(TiredApplication, REAL);

describe("a launch over time", () => {
  loop(
    "a launch inside a loop: each pass its own launch id, records of the earlier pass ignored",
    async ({ app, mockLlm }) => {
      mockLlm(LoopPlannerAgent).thenReturn(
        replyWith(PlanDto, { outline: "v1" }),
        replyWith(PlanDto, { outline: "v2" }),
      );
      mockLlm(LoopCriticAgent).thenReturn(
        replyWith(CritiqueDto, { remark: "redo" }),
        replyWith(CritiqueDto, { remark: "thin" }),
        replyWith(CritiqueDto, { remark: "fine" }),
        replyWith(CritiqueDto, { remark: "good" }),
      );

      const result = await execute(app, PlanLoopWorkflowStart, { text: "tea" });

      expect(result).toFinishWith(CritiquesWorkflowFinish, { text: "fine, good" });
      expect(result.launches.map((launch) => launch.launch)).toEqual([
        `${result.executionId}:loop-planner-agent:1`,
        `${result.executionId}:loop-planner-agent:2`,
      ]);
      expect(result.path.filter((node) => node.startsWith("loop-critic-agent"))).toEqual([
        "loop-critic-agent#1",
        "loop-critic-agent#2",
        "loop-critic-agent#1",
        "loop-critic-agent#2",
      ]);
    },
  );

  tired(
    "each launch is one visit of its node: copies share it, the second launch passes maxVisits",
    async ({ app, mockLlm }) => {
      mockLlm(TiredPlannerAgent).thenReturn(
        replyWith(PlanDto, { outline: "v1" }),
        replyWith(PlanDto, { outline: "v2" }),
      );
      mockLlm(TiredCriticAgent).thenReturnAlways(replyWith(CritiqueDto, { remark: "redo" }));

      const result = await execute(app, TiredWorkflowStart, { text: "tea" });

      // pass 1: both copies are visit 1 of tired-critic-agent; pass 2 would be visit 2 > maxVisits 1
      expect(result).toFinishWith(TiredWorkflowFinish, { outline: "v2" });
      expect(mockLlm(TiredCriticAgent).requests).toHaveLength(2);
      expect(result.launches[1]?.branches).toMatchObject([
        {
          nodeId: "tired-critic-agent#1",
          status: BranchStatus.Failed,
          error: { code: "limit.visits" },
        },
        { nodeId: "tired-critic-agent#2" },
      ]);
    },
  );
});
