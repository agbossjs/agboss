/**
 * #262 PR 2 — scripts (AC6, AC7, AC8): `when(…)` binds turns to a node's input values, a call no
 * script matches fails naming its input; an unused script fails the test at its end (a failed test
 * reports its own failure); `replyWith(Dto, fields, { cost })` and `routeTo(…)` before a launch;
 * `waitFor(…)` on the test's clock. Compile-time checks: `scripts.test-d.ts`.
 */
import { describe, expect, onTestFailed } from "vitest";
import { BranchStatus } from "../../src/index.js";
import { replyWith, routeTo, TestFailure, testWith, waitFor } from "../../src/testing/index.js";
import { seconds, usd } from "../../src/units/index.js";
import {
  ChatApplication,
  ChatWorkflowFinish,
  IntakeWorkflowStart,
  MainRouter,
  ProfilerAgent,
  ScoutAgent,
} from "../flow/fixtures/chat.fixture.js";
import { CompanyScoreDto } from "../flow/fixtures/data-dtos.js";
import { OpeningsDto, ProfileDto } from "../flow/fixtures/dtos.js";
import {
  BatchRankAgent,
  CompanyBatchWorkflowStart,
  CompanyCheckApplication,
} from "../flow/fixtures/starts.fixture.js";
import { CustomerReplyDto, LoyaltyOfferDto, OrderStatusDto } from "../flow/fixtures/data-dtos.js";
import { RefundPolicyDto } from "../flow/fixtures/launch-dtos.js";
import {
  AnswerAgent,
  HelpDeskRouter,
  HelpDeskWorkflowStart,
  LoyaltyOfferAgent,
  OrderLookupAgent,
  RefundPolicyAgent,
} from "../flow/fixtures/launch.fixture.js";
import { HelpDeskApplication } from "../flow/runtime/fixtures/launch.applications.js";
import {
  PickyAnswerAgent,
  PickyApplication,
  PickyRouter,
  PickyWorkflowStart,
} from "../flow/runtime/fixtures/router-launch.workflow.js";
import { execute } from "../helpers/flow.js";

const chat = testWith(ChatApplication);
const companies = testWith(CompanyCheckApplication);
const desk = testWith(HelpDeskApplication);
const picky = testWith(PickyApplication);

const openings = (text: string) => replyWith(OpeningsDto, { openings: text });
const ranked = (score: string) => replyWith(CompanyScoreDto, { score });

describe("AC6: when(…) binds a script to the node's input values", () => {
  chat(
    "the scout answers by what it reads, in any order of the calls",
    async ({ app, mockLlm }) => {
      mockLlm(MainRouter).thenReturn(
        routeTo(ProfilerAgent),
        routeTo(ScoutAgent),
        routeTo(ScoutAgent),
      );
      mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "TS backend" }));
      mockLlm(ScoutAgent)
        .when({ profile: { summary: "TS backend" } })
        .thenReturn(openings("3 TypeScript roles"));
      mockLlm(ScoutAgent).when({ profile: undefined }).thenReturn(openings("send a resume first"));

      const withProfile = await app.execute(IntakeWorkflowStart, { text: "my resume" });
      const without = await app.execute(IntakeWorkflowStart, { text: "any jobs?" });

      expect(withProfile).toFinishWith(ChatWorkflowFinish, { openings: "3 TypeScript roles" });
      expect(without).toFinishWith(ChatWorkflowFinish, { openings: "send a resume first" });
    },
  );

  chat("an omitted key is not checked: when({}) matches every call", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).when({}).thenReturn(routeTo(ScoutAgent));
    mockLlm(ScoutAgent).when({}).thenReturn(openings("any"));

    const result = await app.execute(IntakeWorkflowStart, { text: "jobs?" });

    expect(result).toFinishWith(ChatWorkflowFinish, { openings: "any" });
  });

  chat("a call no script matches fails the test, naming its input", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
    mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "Go backend" }));
    mockLlm(ScoutAgent)
      .when({ profile: { summary: "TS" } })
      .thenReturnAlways(openings("never"));

    const run = app.execute(IntakeWorkflowStart, { text: "my resume" });

    await expect(run).rejects.toFailWith(TestFailure, { code: "test.no-matching-script" });
    await expect(run).rejects.toThrow(
      'no script of mockLlm(ScoutAgent) matches the input {"profile":{"summary":"Go backend"}}',
    );
  });

  chat("a when(…) that ran out fails as an exhausted script", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturnAlways(routeTo(ScoutAgent));
    mockLlm(ScoutAgent).when({ profile: undefined }).thenReturn(openings("once"));
    const first = await app.execute(IntakeWorkflowStart, { text: "jobs?" });

    const again = app.execute(IntakeWorkflowStart, { text: "more?" }, { threadId: first.threadId });

    await expect(again).rejects.toThrow(
      /script exhausted for ScoutAgent: 1 turn scripted, asked for #2/,
    );
  });

  chat(
    "a loop's visits: the router's own turns by position, the scout's by its input",
    async ({ app, mockLlm }) => {
      mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
      mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "Rust" }));
      mockLlm(ScoutAgent)
        .when({ profile: { summary: "Rust" } })
        .thenReturn(openings("2 Rust roles"));

      const result = await app.execute(IntakeWorkflowStart, { text: "my resume" });

      expect(result).toFollowPath([
        IntakeWorkflowStart,
        MainRouter,
        ProfilerAgent,
        MainRouter,
        ScoutAgent,
        ChatWorkflowFinish,
      ]);
      expect(mockLlm(MainRouter).inputs).toHaveLength(2);
    },
  );

  companies(
    "a listOf field is compared by length and position; [] matches an empty list",
    async ({ app, mockLlm }) => {
      mockLlm(BatchRankAgent).when({ companies: [] }).thenReturn(ranked("none"));
      mockLlm(BatchRankAgent)
        .when({ companies: [{ name: "Acme" }] })
        .thenReturn(ranked("one"));
      mockLlm(BatchRankAgent)
        .when({ companies: [{ name: "Acme" }, { name: "Beta" }] })
        .thenReturn(ranked("two"));

      const two = await app.execute(CompanyBatchWorkflowStart, [
        { name: "Acme" },
        { name: "Beta" },
      ]);
      const none = await app.execute(CompanyBatchWorkflowStart, []);
      const one = await app.execute(CompanyBatchWorkflowStart, [{ name: "Acme" }]);

      expect([two.output, none.output, one.output]).toEqual([
        { score: "two" },
        { score: "none" },
        { score: "one" },
      ]);
    },
  );
});

/** What the test of a failing body saw: its own error, never the leftovers. */
const failedWith: string[] = [];

describe("AC7: a script is an expectation", { shuffle: false }, () => {
  chat.fails("an unused when(…) fails the test at its end", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent));
    mockLlm(ScoutAgent).thenReturn(openings("3"));
    mockLlm(ScoutAgent)
      .when({ profile: { summary: "never sent" } })
      .thenReturn(openings("x"));

    expect(await app.execute(IntakeWorkflowStart, { text: "jobs?" })).toFinishWith(
      ChatWorkflowFinish,
    );
  });

  chat.fails(
    "a thenReturn turn never taken fails the test at its end",
    async ({ app, mockLlm }) => {
      mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent), routeTo(ScoutAgent));
      mockLlm(ScoutAgent).thenReturn(openings("3"));

      expect(await app.execute(IntakeWorkflowStart, { text: "jobs?" })).toFinishWith(
        ChatWorkflowFinish,
      );
    },
  );

  chat("thenReturnAlways is never a leftover, under when(…) too", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturnAlways(routeTo(ScoutAgent));
    mockLlm(ScoutAgent).thenReturnAlways(openings("3"));
    mockLlm(ScoutAgent)
      .when({ profile: { summary: "never sent" } })
      .thenReturnAlways(openings("x"));

    expect(await app.execute(IntakeWorkflowStart, { text: "jobs?" })).toFinishWith(
      ChatWorkflowFinish,
    );
  });

  chat.fails("a test that already failed reports its own failure", async ({ mockLlm }) => {
    onTestFailed(({ task }) => {
      failedWith.push(...(task.result?.errors ?? []).map((error) => error.message));
    });
    mockLlm(ScoutAgent).thenReturn(openings("never asked"));

    expect.fail("the test's own failure");
  });

  chat("(the failed test above saw its own failure only)", () => {
    expect(failedWith).toEqual(["the test's own failure"]);
  });
});

describe("AC8: a scripted cost is the execution's spend", () => {
  chat("replyWith(Dto, fields, { cost }) adds the cost", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent, { cost: usd(0.001) }));
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "3" }, { cost: usd(0.03) }));

    const result = await app.execute(IntakeWorkflowStart, { text: "jobs?" });

    expect(result.spend.totalUsd).toBeCloseTo(0.031, 6);
  });
});

describe("AC8 (Q55): routeTo(…) of a router before a launch", () => {
  desk(
    "on a decision model: the OnDemand targets it names are launched, routeTo() none",
    async ({ app, mockLlm }) => {
      const reply = replyWith(CustomerReplyDto, { text: "Here.", holdForReview: false });
      mockLlm(HelpDeskRouter).thenReturn(routeTo(RefundPolicyAgent), routeTo());
      mockLlm(OrderLookupAgent).thenReturn(
        ...[1, 2].map(() => replyWith(OrderStatusDto, { status: "shipped" })),
      );
      mockLlm(RefundPolicyAgent).thenReturn(replyWith(RefundPolicyDto, { policy: "30 days" }));
      mockLlm(LoyaltyOfferAgent).thenReturn(
        ...[1, 2].map(() => replyWith(LoyaltyOfferDto, { offer: "10% off" })),
      );
      mockLlm(AnswerAgent).thenReturn(reply, reply);

      const refund = await app.execute(HelpDeskWorkflowStart, { text: "a refund?" });
      const plain = await app.execute(HelpDeskWorkflowStart, { text: "where is it?" });

      const statusOf = (nodeId: string, launches: typeof refund.launches) =>
        launches[0]?.branches.find((branch) => branch.nodeId === nodeId)?.status;
      expect(statusOf("refund-policy-agent", refund.launches)).toBe(BranchStatus.Finished);
      expect(statusOf("refund-policy-agent", plain.launches)).toBeUndefined();
    },
  );

  picky("on a chat model: a yes for each target it names", async ({ app, mockLlm }) => {
    mockLlm(PickyRouter).thenReturn(routeTo(LoyaltyOfferAgent));
    mockLlm(LoyaltyOfferAgent).thenReturn(replyWith(LoyaltyOfferDto, { offer: "10% off" }));
    mockLlm(PickyAnswerAgent).thenReturn(
      replyWith(CustomerReplyDto, { text: "Here.", holdForReview: false }),
    );

    const result = await execute(app, PickyWorkflowStart, { text: "I always buy here" });

    expect(result.path).toContain("loyalty-offer-agent");
    expect(result.path).not.toContain("refund-policy-agent");
  });

  picky("a target it does not launch fails the test", async ({ app, mockLlm }) => {
    mockLlm(PickyRouter).thenReturn(routeTo(PickyAnswerAgent));

    const run = execute(app, PickyWorkflowStart, { text: "hi" });

    await expect(run).rejects.toThrow(
      /routeTo\(picky-answer-agent\) for PickyRouter: not among the routes it launches/,
    );
  });
});

describe("waitFor(…): a call takes time on the test's clock", () => {
  chat("the answer comes only when the clock reaches it", async ({ app, mockLlm, clock }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent));
    mockLlm(ScoutAgent).thenReturn(waitFor(seconds(31)), openings("late"));
    let settled = false;

    const run = app.execute(IntakeWorkflowStart, { text: "jobs?" }).finally(() => {
      settled = true;
    });
    await clock.advance(seconds(30));
    const before = settled;
    await clock.advance(seconds(1));

    expect(before).toBe(false);
    expect(await run).toFinishWith(ChatWorkflowFinish, { openings: "late" });
  });
});
