import { StepError } from "../../src/core/error-families/step-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  decideWith,
  failWith,
  ModelFailure,
  replyWith,
  replyWithInvalidAnswer,
  routeTo,
  waitFor,
  type WorkflowFixtures,
} from "../../src/testing/index.js";
import { seconds, usd } from "../../src/units/index.js";
import {
  type AnswerOf,
  type BooleanAnswer,
  type BooleanQuestion,
  Decision,
  type DecisionAnswer,
  type DecisionQuestion,
} from "../../src/index.js";
import type * as Core from "../../src/index.js";
import { testWith } from "../../src/testing/index.js";
import { ChatApplication } from "../flow/fixtures/chat.fixture.js";
import { CompanyDto, CompanyScoreDto } from "../flow/fixtures/data-dtos.js";
import { OpeningsDto, ProfileDto, ResumeMissingDto, ShortlistDto } from "../flow/fixtures/dtos.js";
import {
  MainRouter,
  NoReplyWorkflowFinish,
  ProfilerAgent,
  ScoutAgent,
} from "../flow/fixtures/chat.fixture.js";
import {
  ApprovedVerdictDto,
  RejectedVerdictDto,
  VerdictAgent,
} from "../flow/fixtures/markers.fixture.js";
import { BatchRankAgent } from "../flow/fixtures/starts.fixture.js";
import {
  HelpDeskRouter,
  RefundPolicyAgent,
  OrderLookupAgent,
} from "../flow/fixtures/launch.fixture.js";
import { ReviewDraftAction } from "../flow/fixtures/history.fixture.js";

/**
 * Compile-time checks of scripts and call matchers (#262 AC6, AC8, AC9) against the generated
 * `.agboss/types.d.ts` of the fixtures (`check:types`). Each `@ts-expect-error` is a negative test:
 * tsc fails this file if the line compiles. Never run: the declared fixtures only type the calls.
 */
declare const mockModel: WorkflowFixtures["mockModel"];
declare const mockAction: WorkflowFixtures["mockAction"];

describe("#395 PR 3: replyWithInvalidAnswer is checked against the agent's output classes", () => {
  it("a class of the agent's output compiles, whatever the fields; one outside it does not", () => {
    mockModel(ProfilerAgent).thenReturn(replyWithInvalidAnswer(ProfileDto, { summary: 3 }));
    mockModel(ScoutAgent).thenReturn(replyWithInvalidAnswer(OpeningsDto, { openings: 3 }));
    // @ts-expect-error — OpeningsDto is not one of profiler-agent's outputs
    mockModel(ProfilerAgent).thenReturn(replyWithInvalidAnswer(OpeningsDto, {}));
    // @ts-expect-error — a single output: not a list
    mockModel(ScoutAgent).thenReturn(replyWithInvalidAnswer(OpeningsDto, [{ openings: 3 }]));
    expect(true).toBe(true);
  });
});

describe("#262 AC8: replyWith is checked against the agent's output", () => {
  it("a class of the agent's oneOf compiles; one outside it does not", () => {
    mockModel(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "TS, 8 years" }));
    mockModel(ProfilerAgent).thenReturn(replyWith(ResumeMissingDto, {}));
    mockModel(VerdictAgent).thenReturn(
      replyWith(ApprovedVerdictDto, { note: "ok" }),
      replyWith(RejectedVerdictDto, { note: "no" }),
    );
    // @ts-expect-error — OpeningsDto is not one of profiler-agent's outputs
    mockModel(ProfilerAgent).thenReturn(replyWith(OpeningsDto, { openings: "3" }));
    // @ts-expect-error — a single output: not a list
    mockModel(ScoutAgent).thenReturn(replyWith(OpeningsDto, [{ openings: "3" }]));
    // @ts-expect-error — the fields are the class's: summary is a string
    mockModel(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: 3 }));
    expect(true).toBe(true);
  });

  it("text, failures, waits and costs are any agent's turns", () => {
    mockModel(ScoutAgent).thenReturn(
      waitFor(seconds(31)),
      replyWith(OpeningsDto, { openings: "3" }, { cost: usd(0.01) }),
      replyWith("free text"),
      failWith(ModelFailure.Timeout),
    );
    // @ts-expect-error — an agent is not a router: no routeTo
    mockModel(ScoutAgent).thenReturn(routeTo(ProfilerAgent));
    expect(true).toBe(true);
  });
});

describe("#262 AC8 (Q55): routeTo is checked against Route<R>", () => {
  it("after .onRoute(…): exactly one target of the router's routes", () => {
    mockModel(MainRouter).thenReturn(routeTo(ScoutAgent), routeTo(NoReplyWorkflowFinish));
    // @ts-expect-error — not a route of main-router
    mockModel(MainRouter).thenReturn(routeTo(VerdictAgent));
    // @ts-expect-error — .onRoute(…) takes exactly one target
    mockModel(MainRouter).thenReturn(routeTo(ScoutAgent, ProfilerAgent));
    // @ts-expect-error — .onRoute(…) takes exactly one target
    mockModel(MainRouter).thenReturn(routeTo());
    // @ts-expect-error — a router is not an agent: no replyWith
    mockModel(MainRouter).thenReturn(replyWith("scout"));
    expect(true).toBe(true);
  });

  it("before a launch: the OnDemand targets it launches, none with an Always route", () => {
    mockModel(HelpDeskRouter).thenReturn(routeTo(RefundPolicyAgent), routeTo());
    mockModel(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0.9 }));
    // @ts-expect-error — order-lookup-agent is an Always route: the framework launches it
    mockModel(HelpDeskRouter).thenReturn(routeTo(OrderLookupAgent));
    expect(true).toBe(true);
  });
});

describe("#262 AC6: when(…) takes PartialValues<InputOf<Node>>", () => {
  it("values, deep partials, undefined for an absent field, lists by position", () => {
    mockModel(ScoutAgent)
      .when({ profile: { summary: "TS" } })
      .thenReturn(replyWith("…"));
    mockModel(ScoutAgent).when({ profile: undefined }).thenReturnAlways(replyWith("…"));
    mockModel(ScoutAgent).when({}).thenReturn(replyWith("…"));
    mockModel(BatchRankAgent)
      .when({ companies: [] })
      .thenReturn(replyWith(CompanyScoreDto, { score: "9" }));
    mockModel(BatchRankAgent).when({ companies: [{ name: "Acme" }, {}] });
    // @ts-expect-error — a misspelled field
    mockModel(ScoutAgent).when({ profil: { summary: "TS" } });
    // @ts-expect-error — the producer is not compared: values only
    mockModel(ScoutAgent).when({ profile: { producer: ProfilerAgent } });
    // @ts-expect-error — a list field is matched by a list
    mockModel(BatchRankAgent).when({ companies: { name: "Acme" } });
  });
});

describe("#262 AC9: the call matchers are typed by the component", () => {
  it("toHaveBeenCalledWith takes the same matcher as when; toHaveReturned a returned class", () => {
    expect(mockModel(ScoutAgent)).toHaveBeenCalledWith({ profile: { summary: "TS" } });
    expect(mockModel(ScoutAgent)).not.toHaveBeenCalledWith({ profile: undefined });
    expect(mockModel(ScoutAgent)).toHaveBeenCalledTimes(1);
    expect(mockModel(ProfilerAgent)).toHaveReturned(ProfileDto, { summary: "TS" });
    expect(mockAction(ReviewDraftAction)).toHaveBeenCalledTimes(2);
    // @ts-expect-error — a misspelled field
    expect(mockModel(ScoutAgent)).toHaveBeenCalledWith({ profil: {} });
    // @ts-expect-error — profiler-agent does not return ShortlistDto
    expect(mockModel(ProfilerAgent)).toHaveReturned(ShortlistDto);
  });
});

describe("#262 AC10, AC11: toFailWith's fields; no limits option", () => {
  it("the fields are the error class's own; cause is a class", () => {
    const failure: unknown = new Error("x");
    expect(failure).toFailWith(StepError.Router, { nodeId: "main-router", cause: Error });
    expect(failure).toFailWith(LimitError.Budget, { budget: { name: "tenant-daily-budget" } });
    // @ts-expect-error — a misspelled field of StepError.Router
    expect(failure).toFailWith(StepError.Router, { nodeID: "main-router" });
    // @ts-expect-error — testWith has no limits option: a limit is reached through mockService(Budget)
    testWith(ChatApplication, { limits: { perRun: 1 } });
  });
});

describe("#1291: a yes/no question is Decision.boolean, its answer a probability", () => {
  it("Decision.boolean builds a BooleanQuestion whose answer is a BooleanAnswer", () => {
    expectTypeOf<Parameters<typeof Decision.boolean>>().toEqualTypeOf<
      [instructions: string, criteria?: { readonly true: string; readonly false: string }]
    >();
    expectTypeOf(Decision.boolean("is it?")).toEqualTypeOf<BooleanQuestion>();
    expectTypeOf<BooleanQuestion["type"]>().toEqualTypeOf<"boolean">();
    expectTypeOf<BooleanAnswer>().toEqualTypeOf<{
      readonly type: "boolean";
      readonly probability: number;
    }>();
    expectTypeOf<AnswerOf<BooleanQuestion>>().toEqualTypeOf<BooleanAnswer>();
    expectTypeOf<Extract<DecisionQuestion, { type: "boolean" }>>().toEqualTypeOf<BooleanQuestion>();
    expectTypeOf<Extract<DecisionAnswer, { type: "boolean" }>>().toEqualTypeOf<BooleanAnswer>();
  });

  it("0.1.0's noul names are gone", () => {
    // @ts-expect-error — Decision.noul is Decision.boolean
    expectTypeOf(Decision.noul).toBeFunction();
    // @ts-expect-error — NoulQuestion is BooleanQuestion
    expectTypeOf<Core.NoulQuestion>().toBeObject();
    // @ts-expect-error — NoulAnswer is BooleanAnswer
    expectTypeOf<Core.NoulAnswer>().toBeObject();
    // @ts-expect-error — BooleanAnswer.noul is BooleanAnswer.probability
    expectTypeOf<BooleanAnswer["noul"]>().toBeNumber();
    expectTypeOf<Extract<DecisionQuestion, { type: "noul" }>>().toBeNever();
  });
});
