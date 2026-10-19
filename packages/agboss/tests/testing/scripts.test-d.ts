import { describe, expect, it } from "vitest";
import { variant } from "../../src/flow/dto-wrappers.js";
import {
  decideWith,
  failWith,
  ModelFailure,
  replyWith,
  routeTo,
  waitFor,
  type WorkflowFixtures,
} from "../../src/testing/index.js";
import { seconds, usd } from "../../src/units/index.js";
import { BudgetExceededError, RouterFailedError } from "../../src/index.js";
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
declare const mockLlm: WorkflowFixtures["mockLlm"];
declare const mockAction: WorkflowFixtures["mockAction"];

describe("#262 AC8: replyWith is checked against the agent's output", () => {
  it("a class of the agent's oneOf compiles; one outside it does not", () => {
    mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "TS, 8 years" }));
    mockLlm(ProfilerAgent).thenReturn(replyWith(ResumeMissingDto, {}));
    mockLlm(VerdictAgent).thenReturn(
      replyWith(ApprovedVerdictDto, { note: "ok" }),
      replyWith(RejectedVerdictDto, { note: "no" }),
    );
    // @ts-expect-error — OpeningsDto is not one of profiler-agent's outputs
    mockLlm(ProfilerAgent).thenReturn(replyWith(OpeningsDto, { openings: "3" }));
    // @ts-expect-error — a single output: not a list
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, [{ openings: "3" }]));
    // @ts-expect-error — the fields are the class's: summary is a string
    mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: 3 }));
    expect(true).toBe(true);
  });

  it("text, failures, waits and costs are any agent's turns", () => {
    mockLlm(ScoutAgent).thenReturn(
      waitFor(seconds(31)),
      replyWith(OpeningsDto, { openings: "3" }, { cost: usd(0.01) }),
      replyWith("free text"),
      failWith(ModelFailure.Timeout),
    );
    // @ts-expect-error — an agent is not a router: no routeTo
    mockLlm(ScoutAgent).thenReturn(routeTo(ProfilerAgent));
    expect(true).toBe(true);
  });
});

describe("#262 AC8 (Q55): routeTo is checked against Route<R>", () => {
  it("after chooseOne: exactly one target of the router's routes", () => {
    mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent), routeTo(NoReplyWorkflowFinish));
    // @ts-expect-error — not a route of main-router
    mockLlm(MainRouter).thenReturn(routeTo(VerdictAgent));
    // @ts-expect-error — chooseOne takes exactly one target
    mockLlm(MainRouter).thenReturn(routeTo(ScoutAgent, ProfilerAgent));
    // @ts-expect-error — chooseOne takes exactly one target
    mockLlm(MainRouter).thenReturn(routeTo());
    // @ts-expect-error — a router is not an agent: no replyWith
    mockLlm(MainRouter).thenReturn(replyWith("scout"));
    expect(true).toBe(true);
  });

  it("before a launch: the OnDemand targets it launches, none with an Always route", () => {
    mockLlm(HelpDeskRouter).thenReturn(routeTo(RefundPolicyAgent), routeTo());
    mockLlm(HelpDeskRouter).thenReturn(decideWith({ "refund-policy-agent": 0.9 }));
    // @ts-expect-error — order-lookup-agent is an Always route: the framework launches it
    mockLlm(HelpDeskRouter).thenReturn(routeTo(OrderLookupAgent));
    expect(true).toBe(true);
  });
});

describe("#262 AC6: when(…) takes PartialValues<InputOf<Node>>", () => {
  it("values, deep partials, undefined for an absent field, lists by position", () => {
    mockLlm(ScoutAgent)
      .when({ profile: { summary: "TS" } })
      .thenReturn(replyWith("…"));
    mockLlm(ScoutAgent).when({ profile: undefined }).thenReturnAlways(replyWith("…"));
    mockLlm(ScoutAgent).when({}).thenReturn(replyWith("…"));
    mockLlm(BatchRankAgent)
      .when({ companies: [] })
      .thenReturn(replyWith(CompanyScoreDto, { score: "9" }));
    mockLlm(BatchRankAgent).when({ companies: [{ name: "Acme" }, {}] });
    // @ts-expect-error — a misspelled field
    mockLlm(ScoutAgent).when({ profil: { summary: "TS" } });
    // @ts-expect-error — the producer is not compared: values only
    mockLlm(ScoutAgent).when({ profile: { producer: ProfilerAgent } });
    // @ts-expect-error — a list field is matched by a list
    mockLlm(BatchRankAgent).when({ companies: { name: "Acme" } });
    expect(variant(CompanyDto, { name: "Acme" })).toBeDefined();
  });
});

describe("#262 AC9: the call matchers are typed by the component", () => {
  it("toHaveBeenCalledWith takes the same matcher as when; toHaveReturned a returned class", () => {
    expect(mockLlm(ScoutAgent)).toHaveBeenCalledWith({ profile: { summary: "TS" } });
    expect(mockLlm(ScoutAgent)).not.toHaveBeenCalledWith({ profile: undefined });
    expect(mockLlm(ScoutAgent)).toHaveBeenCalledTimes(1);
    expect(mockLlm(ProfilerAgent)).toHaveReturned(ProfileDto, { summary: "TS" });
    expect(mockAction(ReviewDraftAction)).toHaveBeenCalledTimes(2);
    // @ts-expect-error — a misspelled field
    expect(mockLlm(ScoutAgent)).toHaveBeenCalledWith({ profil: {} });
    // @ts-expect-error — profiler-agent does not return ShortlistDto
    expect(mockLlm(ProfilerAgent)).toHaveReturned(ShortlistDto);
  });
});

describe("#262 AC10, AC11: toFailWith's fields; no limits option", () => {
  it("the fields are the error class's own; cause is a class", () => {
    const failure: unknown = new Error("x");
    expect(failure).toFailWith(RouterFailedError, { nodeId: "main-router", cause: Error });
    expect(failure).toFailWith(BudgetExceededError, { budget: { name: "tenant-daily-budget" } });
    // @ts-expect-error — a misspelled field of RouterFailedError
    expect(failure).toFailWith(RouterFailedError, { nodeID: "main-router" });
    // @ts-expect-error — testWith has no limits option: a limit is reached through mockOf(Budget)
    testWith(ChatApplication, { limits: { perRun: 1 } });
  });
});
