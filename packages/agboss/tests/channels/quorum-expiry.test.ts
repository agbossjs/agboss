/**
 * #945 — a quorum whose reviewer never answers: the quorum's deadline binds the branch's pause, the
 * tree wakes by itself, the branch ends `Expired` (not `Cancelled`, not `Skipped`) and counts as
 * "did not vote".
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { BranchStatus, PauseResolution, PauseStatus } from "../../src/index.js";
import { PauseExpiredError } from "../../src/flow/runtime/pause-expired-error.js";
import { QuorumNotReachedError } from "../../src/flow/runtime/launch/quorum-errors.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { answerFor, askFor, manager, until } from "./fixtures/pause-scripts.js";
import { pauseStore, RefundTool, resetPauses, seen } from "./fixtures/pauses.workflow.js";
import {
  FraudAgent,
  PolicyAgent,
  RiskAgent,
  RefundScoreDto,
} from "./fixtures/refund-panel.workflow.js";
import {
  QuickScoreAgent,
  qe,
  QuorumExpiryApplication,
  QuorumExpiryGroupsWorkflowStart,
  QuorumExpiryOneWorkflowStart,
  QuorumExpiryShortOneWorkflowStart,
  SkipExpiryWorkflowStart,
  QuorumExpiryShortWorkflowStart,
  PlainExpiryHandledWorkflowStart,
  PlainExpiryWorkflowStart,
  QuorumExpiryWorkflowStart,
  ShortFraudAgent,
  ShortPolicyAgent,
  ShortRefundTool,
  ShortRiskAgent,
  resetQuorumExpiry,
} from "./fixtures/quorum-expiry.workflow.js";

const test = testWith(QuorumExpiryApplication);
const score = (value: number) => replyWith(RefundScoreDto, { score: value });
const ORDER = { orderId: "7" };

beforeEach(() => {
  resetPauses();
  resetQuorumExpiry();
});

const stored = (orderId: string) =>
  pauseStore().findByTenantIdAndPauseId("default", askFor(orderId).pauseId);

describe("AC1: min 2, max 3, two answered, the third never: at the deadline the run goes on", () => {
  test("AC1: at the quorum deadline the join runs with two answers, the third branch Expired with step.pause-expired", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "P" }), score(7));
    mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "R" }), score(9));
    mockLlm(FraudAgent).thenReturn(callTool(RefundTool, { orderId: "F" }));
    const paused = await execute(app, QuorumExpiryWorkflowStart, ORDER);
    expect(paused.status).toBe(ExecutionStatus.Paused);
    await app.resume(answerFor("P"), manager);
    const rested = await app.resume(answerFor("R"), manager);
    // max 3: two counted do not decide; the third pause still waits
    expect(rested.status).toBe(ExecutionStatus.Paused);
    expect(qe.finished).toEqual([]);

    await clock.advance(hours(1));
    await until(() => qe.ended.length === 1);

    expect(qe.finished).toEqual([["7", "9"]]);
    const [decided] = qe.decided;
    expect(decided?.isReached).toBe(true);
    expect(decided?.branches.map((branch) => branch.status)).toEqual([
      BranchStatus.Finished,
      BranchStatus.Finished,
      BranchStatus.Expired,
    ]);
    expect(decided?.branches[2]?.error?.code).toBe("step.pause-expired");
    expect(await stored("F")).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Expired,
    });
  });

  test("AC1: the pause of a quorum branch is bound by the quorum's deadline", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "P" }));
    mockLlm(RiskAgent).thenReturn(score(9));
    mockLlm(FraudAgent).thenReturn(score(5));
    await execute(app, QuorumExpiryWorkflowStart, ORDER);

    const pause = await stored("P");

    expect(pause?.expiryBound).toBe("quorum");
    expect(pause?.expiresAt).toBeDefined();
    expect(Date.parse(pause?.expiresAt ?? "") - Date.parse(pause?.askedAt ?? "")).toBe(hours(1));
  });

  test("AC1: groups — the priority group waits for its third member, the other group is complete", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(score(7));
    mockLlm(RiskAgent).thenReturn(score(9));
    mockLlm(FraudAgent).thenReturn(callTool(RefundTool, { orderId: "F" }));
    mockLlm(QuickScoreAgent).thenReturn(score(1));
    const paused = await execute(app, QuorumExpiryGroupsWorkflowStart, ORDER);
    expect(paused.status).toBe(ExecutionStatus.Paused);

    await clock.advance(hours(1));
    await until(() => qe.ended.length === 1);

    expect(qe.finished).toEqual([["1"]]);
    expect(qe.decided[0]?.branches.map((branch) => branch.status)).toContain(BranchStatus.Expired);
  });

  test("AC1: an answer before the deadline wins the race: the branch is not Expired", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "P" }), score(7));
    mockLlm(RiskAgent).thenReturn(score(9));
    mockLlm(FraudAgent).thenReturn(score(5));
    await execute(app, QuorumExpiryWorkflowStart, ORDER);

    await clock.advance(minutes(59));
    const done = await app.resume(answerFor("P"), manager);

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(seen.asks).toHaveLength(1);
    expect(qe.finished).toEqual([["9", "5", "7"]]);
  });
});

describe("AC2: one answers, two never (their own deadlines pass)", () => {
  test("AC2: QuorumNotReachedError { counted: 1, expired: [two node ids] }", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ShortPolicyAgent).thenReturn(callTool(ShortRefundTool, { orderId: "P" }));
    mockLlm(ShortRiskAgent).thenReturn(callTool(ShortRefundTool, { orderId: "R" }));
    mockLlm(ShortFraudAgent).thenReturn(score(5));
    const paused = await execute(app, QuorumExpiryShortWorkflowStart, ORDER);
    expect(paused.status).toBe(ExecutionStatus.Paused);

    await clock.advance(minutes(30));
    await until(() => qe.errors.length === 1);

    const [error] = qe.errors;
    expect(error).toBeInstanceOf(QuorumNotReachedError);
    expect(error).toMatchObject({
      counted: 1,
      expired: ["short-policy-agent", "short-risk-agent"],
    });
    expect(error?.message).toContain("1 counted, need 2, 2 expired");
  });

  test("AC2: with min 1 it goes on", async ({ app, clock, mockLlm }) => {
    mockLlm(ShortPolicyAgent).thenReturn(callTool(ShortRefundTool, { orderId: "P" }));
    mockLlm(ShortRiskAgent).thenReturn(callTool(ShortRefundTool, { orderId: "R" }));
    mockLlm(ShortFraudAgent).thenReturn(score(5));
    await execute(app, QuorumExpiryShortOneWorkflowStart, ORDER);

    await clock.advance(minutes(30));
    await until(() => qe.ended.length === 1);

    expect(qe.finished).toEqual([["5"]]);
    expect(qe.decided[0]?.branches.map((branch) => branch.status)).toEqual([
      BranchStatus.Expired,
      BranchStatus.Expired,
      BranchStatus.Finished,
    ]);
  });
});

describe("AC3: an expired reviewer never fails the panel", () => {
  test("AC3: FailFast quorum (the default): an expired branch never fails the launch", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(PolicyAgent).thenReturn(score(7));
    mockLlm(RiskAgent).thenReturn(score(9));
    mockLlm(FraudAgent).thenReturn(callTool(RefundTool, { orderId: "F" }));
    await execute(app, QuorumExpiryOneWorkflowStart, ORDER);

    await clock.advance(hours(1));
    await until(() => qe.ended.length === 1);

    expect(qe.errors).toEqual([]);
    expect(qe.finished).toEqual([["7", "9"]]);
  });
});

describe("Q11: a plain .join() follows its FailurePolicy", () => {
  test("AC3: plain + FailFast: the launch fails with PauseExpiredError; the waiting sibling is withdrawn, no hang", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ShortPolicyAgent).thenReturn(callTool(ShortRefundTool, { orderId: "S" }));
    mockLlm(ShortRiskAgent).thenReturn(score(9));
    mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "W" }));
    const paused = await execute(app, PlainExpiryWorkflowStart, ORDER);
    expect(paused.status).toBe(ExecutionStatus.Paused);

    await clock.advance(minutes(30));
    await until(() => qe.errors.length === 1);

    expect(qe.errors[0]).toBeInstanceOf(PauseExpiredError);
    expect(qe.shortAsks).toHaveLength(1);
    expect(await stored("W")).toMatchObject({
      status: PauseStatus.Cancelled,
      resolution: PauseResolution.Withdrawn,
    });
  });

  test("AC3: Expired under FailFast in a plain join enters .onJoinError, not the main path", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ShortPolicyAgent).thenReturn(callTool(ShortRefundTool, { orderId: "S" }));
    mockLlm(ShortRiskAgent).thenReturn(score(9));
    mockLlm(PolicyAgent).thenReturn(callTool(RefundTool, { orderId: "W" }));
    await execute(app, PlainExpiryHandledWorkflowStart, ORDER);

    await clock.advance(minutes(30));
    await until(() => qe.ended.length === 1);

    expect(qe.finished).toEqual([]);
    expect(qe.errors).toEqual([]);
    expect(qe.ended[0]?.finish.name).toBe("plain-expiry-escalated-workflow-finish");
  });
});

describe("Q11: a plain .join() with FailurePolicy.Skip", () => {
  test("AC3: plain + Skip: the expired branch is dropped, the launch goes on", async ({
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(ShortPolicyAgent).thenReturn(callTool(ShortRefundTool, { orderId: "S" }));
    mockLlm(ShortRiskAgent).thenReturn(score(9));
    const paused = await execute(app, SkipExpiryWorkflowStart, ORDER);
    expect(paused.status).toBe(ExecutionStatus.Paused);

    await clock.advance(minutes(30));
    await until(() => qe.ended.length === 1);

    expect(qe.errors).toEqual([]);
    expect(qe.finished).toEqual([["9"]]);
  });
});
