/**
 * #262 AC5 (S33): `testWith(App, { concurrency })` — by default one branch at a time in listed /
 * item order; `TestConcurrency.Real` as in production; `TestConcurrency.inOrder([step(…), …])`
 * orders completions through gates: races, `FailFast` and quorums reproduced on every run.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { BranchStatus, BranchVerdict, ExecutionCancelledError } from "../../src/index.js";
import { decideWith, replyWith, step, TestConcurrency, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { ScoreDto, ScoreReviewDto } from "../flow/fixtures/quorum-dtos.js";
import {
  HirePanelAgent,
  PanelSummaryAgent,
  PanelWorkflowStart,
  resetPanel,
  RisksPanelAgent,
  SkillsPanelAgent,
} from "../flow/fixtures/quorum-runtime-parts.js";
import { QuickPanelApplication } from "../flow/fixtures/quorum-runtime.fixture.js";
import {
  FanOutApplication,
  FanOutUnboundedApplication,
  fanOut,
  ItemsFailedWorkflowFinish,
  ItemsWorkflowStart,
  ProcessItemAction,
  resetFanOut,
  type ItemDto,
} from "../flow/runtime/fixtures/fan-out.workflow.js";
import {
  HelpDeskRouter,
  HelpDeskWorkflowStart,
  LoyaltyOfferAgent,
  OrderLookupAgent,
  RefundPolicyAgent,
} from "../flow/fixtures/launch.fixture.js";
import { HelpDeskApplication } from "../flow/runtime/fixtures/launch.applications.js";
import { LoyaltyOfferDto, OrderStatusDto } from "../flow/fixtures/data-dtos.js";

const item = (name: string, delay = 0, outcome: ItemDto["outcome"] = "ok"): ItemDto => ({
  name,
  delay,
  outcome,
});
const named = (name: string) => step(ProcessItemAction, { item: { name } });
const ANNA = { name: "Anna" };
const score = (value: number) => replyWith(ScoreDto, { score: value });
const summary = replyWith(ScoreReviewDto, { text: "summed up" });

beforeEach(() => {
  resetFanOut();
  resetPanel();
});

describe("AC5: the default runs branches one at a time, in item order", () => {
  testWith(FanOutUnboundedApplication)(
    "sequential default: no branch starts before the one before it ended",
    async ({ app }) => {
      await execute(app, ItemsWorkflowStart, [item("a", 10), item("b"), item("c", 5)]);

      expect(fanOut.mostInFlight).toBe(1);
      expect(fanOut.events).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    },
  );

  testWith(FanOutUnboundedApplication, { concurrency: TestConcurrency.Real })(
    "real: every branch at once, as in production",
    async ({ app }) => {
      await execute(app, ItemsWorkflowStart, [item("a", 10), item("b"), item("c", 5)]);

      expect(fanOut.mostInFlight).toBe(3);
    },
  );
});

describe("AC5: inOrder orders completions through gates", () => {
  testWith(QuickPanelApplication, {
    concurrency: TestConcurrency.inOrder([step(HirePanelAgent), step(RisksPanelAgent)]),
  })(
    "a quorum counts the listed steps in their order; the last waiting is cancelled at its gate",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result.launches[0]?.branches).toMatchObject([
        { nodeId: "skills-panel-agent", status: BranchStatus.Cancelled },
        { nodeId: "risks-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 2 },
        { nodeId: "hire-panel-agent", verdict: BranchVerdict.Counted, acceptedSequence: 1 },
      ]);
    },
  );

  testWith(QuickPanelApplication, {
    concurrency: TestConcurrency.inOrder([step(SkillsPanelAgent), step(HirePanelAgent)]),
  })(
    "the other order counts the others: the same scripts, another race",
    async ({ app, mockLlm }) => {
      mockLlm(SkillsPanelAgent).thenReturn(score(7));
      mockLlm(RisksPanelAgent).thenReturn(score(6));
      mockLlm(HirePanelAgent).thenReturn(score(9));
      mockLlm(PanelSummaryAgent).thenReturn(summary);

      const result = await execute(app, PanelWorkflowStart, ANNA);

      expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
        BranchStatus.Finished,
        BranchStatus.Cancelled,
        BranchStatus.Finished,
      ]);
    },
  );

  testWith(FanOutApplication, {
    concurrency: TestConcurrency.inOrder([named("b"), named("a")]),
  })(
    "FailFast race: the failure completes first, its sibling is cancelled at its gate",
    async ({ app }) => {
      const result = await execute(app, ItemsWorkflowStart, [item("a"), item("b", 0, "fail")]);

      expect(result).toFinishWith(ItemsFailedWorkflowFinish, { text: "failed on one of 2" });
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
        BranchStatus.Cancelled,
        BranchStatus.Failed,
      ]);
    },
  );

  testWith(FanOutApplication, {
    concurrency: TestConcurrency.inOrder([named("a"), named("b")]),
  })("FailFast race, the other order: the sibling finished before the failure", async ({ app }) => {
    const result = await execute(app, ItemsWorkflowStart, [item("a"), item("b", 0, "fail")]);

    expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
      BranchStatus.Finished,
      BranchStatus.Failed,
    ]);
  });

  testWith(FanOutUnboundedApplication, {
    concurrency: TestConcurrency.inOrder([named("a"), named("b")]),
  })("cancel at the gate: app.cancel ends a waiting step at once", async ({ app }) => {
    const threadId = "thread-cancel";
    const execution = execute(app, ItemsWorkflowStart, [item("a", 60_000), item("b")], {
      threadId,
    });
    const failed = expect(execution).rejects.toFailWith(ExecutionCancelledError);
    await vi.waitFor(() => {
      expect(fanOut.events).toContain("end b");
    });

    await app.cancel(threadId);

    await failed;
    expect(fanOut.events).toEqual(["start a", "start b", "end b", "aborted a"]);
  });

  testWith(FanOutApplication, {
    concurrency: TestConcurrency.inOrder([named("c"), named("a")]),
  })(
    "unreachable step fails fast: every slot is held at a gate, the next step has none",
    async ({ app }) => {
      const execution = execute(app, ItemsWorkflowStart, [item("a"), item("b"), item("c")]);

      await expect(execution).rejects.toThrow(
        'test.unreachable-step: TestConcurrency.inOrder: the next step step(ProcessItemAction, {"item":{"name":"c"}}) cannot complete',
      );
    },
  );

  testWith(HelpDeskApplication, {
    concurrency: TestConcurrency.inOrder([step(RefundPolicyAgent), step(OrderLookupAgent)]),
  })(
    "a step the router never launches fails the test at once, naming it",
    async ({ app, mockLlm }) => {
      mockLlm(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0.1 }));
      mockLlm(OrderLookupAgent).thenReturn(replyWith(OrderStatusDto, { status: "shipped" }));
      mockLlm(LoyaltyOfferAgent).thenReturn(replyWith(LoyaltyOfferDto, { offer: "10% off" }));

      const execution = execute(app, HelpDeskWorkflowStart, { text: "where is my order?" });

      await expect(execution).rejects.toThrow(
        "the next step step(RefundPolicyAgent) cannot complete",
      );
    },
  );

  testWith(FanOutApplication, {
    concurrency: TestConcurrency.inOrder([named("zzz")]),
  }).fails("a listed step never reached fails the test at its end", async ({ app }) => {
    await app.ready();
    expect(fanOut.events).toEqual([]);
  });
});
