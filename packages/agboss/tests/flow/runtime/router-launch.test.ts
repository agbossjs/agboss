import { describe, expect } from "vitest";
import { BranchStatus, BudgetExceededError, RouterDecisionError } from "../../../src/index.js";
import {
  decideWith,
  failWith,
  ModelFailure,
  replyWith,
  testWith,
} from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import { CustomerReplyDto, LoyaltyOfferDto, OrderStatusDto } from "../fixtures/data-dtos.js";
import {
  AnswerAgent,
  HelpDeskRouter,
  HelpDeskWorkflowFinish,
  HelpDeskWorkflowStart,
  LoyaltyOfferAgent,
  OffersAnswerAgent,
  OffersWorkflowFinish,
  OffersWorkflowStart,
  OrderLookupAgent,
  RefundPolicyAgent,
} from "../fixtures/launch.fixture.js";
import { RefundPolicyDto } from "../fixtures/launch-dtos.js";
import { HelpDeskApplication, OffersApplication } from "./fixtures/launch.applications.js";
import {
  BudgetAnswerAgent,
  BudgetDeskApplication,
  BudgetDeskWorkflowStart,
  PickyAnswerAgent,
  PickyApplication,
  PickyRouter,
  PickyWorkflowFinish,
  PickyWorkflowStart,
  StrictApplication,
  StrictWorkflowStart,
} from "./fixtures/router-launch.workflow.js";

/** #273 AC6, S21, S23; #280 S47 (f): a router decides who is launched; the policies are its routes'. */

const desk = testWith(HelpDeskApplication);
const picky = testWith(PickyApplication);
const offers = testWith(OffersApplication);
const strict = testWith(StrictApplication);
const budget = testWith(BudgetDeskApplication);

const reply = replyWith(CustomerReplyDto, { text: "Here you go.", holdForReview: false });
const order = replyWith(OrderStatusDto, { status: "shipped" });
const refund = replyWith(RefundPolicyDto, { policy: "30 days" });
const loyalty = replyWith(LoyaltyOfferDto, { offer: "10% off" });

describe("S23: a model router decides its routes of a chooseMany launch", () => {
  desk(
    "yes/no: one decide, a boolean question per route, yes launches",
    async ({ app, mockModel }) => {
      mockModel(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0.9 }));
      mockModel(OrderLookupAgent).thenReturn(order);
      mockModel(RefundPolicyAgent).thenReturn(refund);
      mockModel(LoyaltyOfferAgent).thenReturn(loyalty);
      mockModel(AnswerAgent).thenReturn(reply);

      const result = await app.execute(HelpDeskWorkflowStart, { text: "can I return it?" });

      expect(result).toFollowPath([
        HelpDeskWorkflowStart,
        HelpDeskRouter,
        OrderLookupAgent,
        LoyaltyOfferAgent,
        RefundPolicyAgent,
        AnswerAgent,
        HelpDeskWorkflowFinish,
      ]);
      const [asked] = mockModel(HelpDeskRouter).requests;
      expect(asked).toMatchObject({
        kind: "decide",
        questions: {
          "refund-policy-agent": { type: "boolean", instructions: "The message is about returns" },
        },
      });
      expect(JSON.stringify(mockModel(AnswerAgent).requests[0]?.input)).toContain("30 days");
    },
  );

  desk("a no leaves the route out: its optional value is none", async ({ app, mockModel }) => {
    mockModel(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0.5 }));
    mockModel(OrderLookupAgent).thenReturn(order);
    mockModel(LoyaltyOfferAgent).thenReturn(loyalty);
    mockModel(AnswerAgent).thenReturn(reply);

    const result = await app.execute(HelpDeskWorkflowStart, { text: "where is it?" });

    expect(result.path).not.toContain("refund-policy-agent");
    expect(result.launches).toMatchObject([{ items: 3, taken: 2 }]);
    expect(JSON.stringify(mockModel(AnswerAgent).requests[0]?.input)).toContain(
      "### refund\\nnone",
    );
  });

  picky("all no: nothing is launched, and an empty answer is valid", async ({ app, mockModel }) => {
    mockModel(PickyRouter).thenReturn(
      decideWith({ "refund-policy-agent": 0.1, "loyalty-offer-agent": 0.2 }),
    );
    mockModel(PickyAnswerAgent).thenReturn(reply);

    const result = await execute(app, PickyWorkflowStart, { text: "hello" });

    expect(result).toFinishWith(PickyWorkflowFinish);
    expect(result.path).toEqual([
      "picky-workflow-start",
      "picky-router",
      "picky-answer-agent",
      "picky-workflow-finish",
    ]);
  });

  picky(
    "a chat-model router answers through one answer tool, a boolean per route",
    async ({ app, mockModel }) => {
      mockModel(PickyRouter).thenReturn(
        decideWith({ "refund-policy-agent": 0, "loyalty-offer-agent": 1 }),
      );
      mockModel(LoyaltyOfferAgent).thenReturn(loyalty);
      mockModel(PickyAnswerAgent).thenReturn(reply);

      const result = await execute(app, PickyWorkflowStart, { text: "I always buy here" });

      expect(result).toFinishWith(PickyWorkflowFinish);
      expect(result.path).toEqual([
        "picky-workflow-start",
        "picky-router",
        "loyalty-offer-agent",
        "picky-answer-agent",
        "picky-workflow-finish",
      ]);
      const [asked] = mockModel(PickyRouter).requests;
      expect(asked?.kind).toBe("chat");
      expect(JSON.stringify(asked)).toContain(
        '"loyalty-offer-agent":{"description":"The customer is loyal","type":"boolean"}',
      );
    },
  );
});

describe("S21: Skip drops only the branch's own step failure", () => {
  desk(
    "Skip drops only StepFailedError: the execution goes on without the value",
    async ({ app, mockModel }) => {
      mockModel(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0 }));
      mockModel(OrderLookupAgent).thenReturn(order);
      mockModel(LoyaltyOfferAgent).thenReturn(failWith(ModelFailure.Timeout));
      mockModel(AnswerAgent).thenReturn(reply);

      const result = await app.execute(HelpDeskWorkflowStart, { text: "where is it?" });

      expect(result).toFinishWith(HelpDeskWorkflowFinish);
      const loyal = result.launches[0]?.branches.find(
        (branch) => branch.nodeId === "loyalty-offer-agent",
      );
      expect(loyal).toMatchObject({ status: BranchStatus.Skipped, error: { code: "step.agent" } });
      expect(JSON.stringify(mockModel(AnswerAgent).requests[0]?.input)).toContain(
        "### loyalty\\nnone",
      );
    },
  );

  budget(
    "a Skip branch hitting a budget cancels the others and fails the step",
    async ({ app, mockModel }) => {
      mockModel(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0 }));
      mockModel(OrderLookupAgent).thenReturn(
        replyWith(OrderStatusDto, { status: "shipped" }, { cost: usd(0.06) }),
      );
      // no scripts for the loyalty branch and the answer: neither is reached

      const run = execute(app, BudgetDeskWorkflowStart, { text: "where is it?" });

      // one at a time: the order spent the run's budget; the loyalty branch (Skip) starts over it —
      // a limit is no step failure, so it fails the launch instead of dropping out
      await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
      expect(mockModel(LoyaltyOfferAgent).requests).toEqual([]);
      expect(mockModel(BudgetAnswerAgent).requests).toEqual([]);
    },
  );
});

describe("#280 S47 (f): a code router launches its Always targets and what route() returns", () => {
  offers(
    "code router Always + route(): the list it returns is launched",
    async ({ app, mockModel }) => {
      mockModel(RefundPolicyAgent).thenReturn(refund, refund);
      mockModel(LoyaltyOfferAgent).thenReturn(loyalty);
      mockModel(OffersAnswerAgent).thenReturn(reply, reply);

      const loyal = await app.execute(OffersWorkflowStart, { text: "a loyal customer" });
      const other = await app.execute(OffersWorkflowStart, { text: "a new customer" });

      expect(loyal.path).toEqual([
        "offers-workflow-start",
        "offers-router",
        "refund-policy-agent",
        "loyalty-offer-agent",
        "offers-answer-agent",
        "offers-workflow-finish",
      ]);
      expect(other.path).not.toContain("loyalty-offer-agent");
      expect(other).toFinishWith(OffersWorkflowFinish);
    },
  );

  strict(
    "a list of its routes runs, none included; one class or a stranger is a decision error",
    async ({ app, mockModel }) => {
      mockModel(RefundPolicyAgent).thenReturn(refund);
      mockModel(LoyaltyOfferAgent).thenReturn(loyalty);
      mockModel(PickyAnswerAgent).thenReturnAlways(reply);

      const both = await execute(app, StrictWorkflowStart, { text: "both" });
      const one = execute(app, StrictWorkflowStart, { text: "one" });
      const ghost = execute(app, StrictWorkflowStart, { text: "ghost" });
      const none = await execute(app, StrictWorkflowStart, { text: "none" });

      expect(both.path).toEqual([
        "strict-workflow-start",
        "strict-router",
        "refund-policy-agent",
        "loyalty-offer-agent",
        "picky-answer-agent",
        "picky-workflow-finish",
      ]);
      await expect(one).rejects.toThrow("returns a list of its routes' targets");
      await expect(ghost).rejects.toThrow("order-lookup-agent: not one of its routes");
      await expect(ghost).rejects.toBeInstanceOf(RouterDecisionError);
      expect(none.path).toEqual([
        "strict-workflow-start",
        "strict-router",
        "picky-answer-agent",
        "picky-workflow-finish",
      ]);
    },
  );

  strict(
    "Skip on a code router's route: a failed agent drops out, the execution goes on",
    async ({ app, mockModel }) => {
      mockModel(RefundPolicyAgent).thenReturn(refund);
      mockModel(LoyaltyOfferAgent).thenReturn(failWith(ModelFailure.Timeout));
      mockModel(PickyAnswerAgent).thenReturn(reply);

      const result = await execute(app, StrictWorkflowStart, { text: "both" });

      expect(result).toFinishWith(PickyWorkflowFinish);
      expect(result.launches[0]?.branches.map((branch) => branch.status)).toEqual([
        BranchStatus.Finished,
        BranchStatus.Skipped,
      ]);
    },
  );
});
