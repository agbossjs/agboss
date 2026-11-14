/**
 * #940 AC1 / AC2: a channel hears every close of a pause it sent (`onPauseClosed`) — answered (by
 * whom, with the masked answer), withdrawn (a decided quorum, a `FailFast` sibling), cancelled
 * (`app.cancel`, the tree's end) — at least once, in the pause's execution frame, under its tool's
 * `timeout`; never for a pause it decided at once or never sent. A hook that throws or hangs is
 * retried and logged and changes nothing else: the join, `.onJoinError` and `app.cancel` go on.
 * Notices are delivered after the change that wrote them, never awaited by it.
 */
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  ExecutionCancelledError,
  PauseClosedReason,
  PauseResolution,
  PauseStatus,
} from "../../src/index.js";
import {
  callTool,
  failWith,
  ModelFailure,
  replyWith,
  testWith,
  waitFor,
} from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { logged, resetLogged } from "../helpers/log.js";
import { answerFor, askFor, manager, until } from "./fixtures/pause-scripts.js";
import {
  ChildPausesApplication,
  ChildRefundAgent,
  SingleChildWorkflowStart,
} from "./fixtures/child-pauses.workflow.js";
import {
  PaymentDeclinedError,
  PayoutConfirmAgent,
  PayoutDeclinedWorkflowFinish,
  PayoutRefundAgent,
  PayoutsApplication,
  PayoutWorkflowStart,
} from "./fixtures/payouts.workflow.js";
import {
  AuditCheckAgent,
  AuditRefundAgent,
  AuditWorkflowStart,
  ConfirmOrderTool,
  DeskClerkAgent,
  DeskWorkflowStart,
  hooks,
  pauseStore,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import {
  FraudAgent,
  PolicyAgent,
  RefundDecidedWorkflowFinish,
  RefundPanelApplication,
  RefundPanelWorkflowStart,
  RefundScoreDto,
  RiskAgent,
} from "./fixtures/refund-panel.workflow.js";

const panel = testWith(RefundPanelApplication);
const desk = testWith(PausesApplication);
const twoInstances = testWith(PausesApplication, { instances: 2 });
const score = (value: number) => replyWith(RefundScoreDto, { score: value });
const ACME = { tenant: { tenantId: "acme" }, threadId: "refund-thread" };
const REFUND = { text: "refund order 7" };

beforeEach(() => {
  resetPauses();
  resetLogged();
});

/** The warnings of notices that failed. */
const failedNotices = () => logged.filter((entry) => entry.code === "pause.notice-failed");

describe("#940 AC1: the channel that asked hears an answer given elsewhere", () => {
  desk(
    "AC1: answered elsewhere: the channel hears answered, answeredBy, the masked answer",
    async ({ app, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(
        callTool(RefundTool, { orderId: "7" }),
        replyWith("Done."),
      );
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);
      expect(paused.status).toBe(ExecutionStatus.Paused);

      await app.resume(answerFor("7", { approved: true, reason: "ok" }), {
        ...manager,
        tenantId: "acme",
      });

      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([
        {
          channel: "finance-desk",
          orderId: "7",
          reason: PauseClosedReason.Answered,
          answeredBy: "manager-17",
          answer: { approved: true, reason: "ok" },
          executionId: paused.executionId,
          tenantId: "acme",
          agent: "desk-clerk-agent",
        },
      ]);
    },
  );

  desk("AC1: the event's value is the question as send got it", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    await execute(app, DeskWorkflowStart, REFUND, ACME);

    await app.cancel(ACME.threadId, { tenantId: "acme" });

    await until(() => seen.closed.length === 1);
    const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
    expect(seen.closed[0]).toMatchObject({ pauseId: stored?.pauseId, reason: "cancelled" });
  });
});

describe("#940 AC2: cancel / FailFast / quorum / tree end: one notice each with its reason", () => {
  panel(
    "AC2: a decided quorum: the surplus branch's pause is withdrawn, its channel told once",
    async ({ app, mockLlm }) => {
      mockLlm(PolicyAgent).thenReturn(score(7));
      mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      mockLlm(FraudAgent).thenReturn(score(9));

      const result = await execute(
        app,
        RefundPanelWorkflowStart,
        { orderId: "7" },
        { record: true },
      );

      expect(result).toFinishWith(RefundDecidedWorkflowFinish);
      expect(result.pending).toEqual([]);
      expect(result.record?.pauses).toMatchObject([{ resolution: PauseResolution.Withdrawn }]);
      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([
        { orderId: "7", reason: PauseClosedReason.Withdrawn, channel: "finance-desk" },
      ]);
    },
  );

  desk(
    "AC2: a FailFast sibling: Withdrawn, in the pause's execution and step",
    async ({ app, clock, mockLlm }) => {
      mockLlm(AuditRefundAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      mockLlm(AuditCheckAgent).thenReturn(waitFor(seconds(5)), failWith(ModelFailure.Timeout));
      const run = execute(app, AuditWorkflowStart, { orderId: "7" }, ACME);
      run.catch(() => undefined);
      await until(() => seen.asks.length === 1);

      await clock.advance(seconds(5));

      await expect(run).rejects.toThrow();
      await until(() => seen.closed.length === 1);
      const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
      expect(seen.closed).toMatchObject([
        {
          channel: "finance-desk",
          pauseId: askFor("7").pauseId,
          orderId: "7",
          reason: PauseClosedReason.Withdrawn,
          executionId: stored?.executionId,
          tenantId: "acme",
          agent: "audit-refund-agent",
        },
      ]);
    },
  );

  desk(
    "AC2: app.cancel of a paused execution: Cancelled, in the pause's frame",
    async ({ app, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);
      expect(paused.status).toBe(ExecutionStatus.Paused);

      await app.cancel(paused.threadId, { tenantId: "acme" });

      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([
        {
          orderId: "7",
          reason: PauseClosedReason.Cancelled,
          executionId: paused.executionId,
          tenantId: "acme",
          agent: "desk-clerk-agent",
        },
      ]);
    },
  );

  testWith(ChildPausesApplication)(
    "AC2: app.cancel of a pause inside a child: told in the child's execution",
    async ({ app, mockLlm }) => {
      mockLlm(ChildRefundAgent).thenReturn(callTool(RefundTool, { orderId: "A" }));
      const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" }, ACME);
      expect(paused.status).toBe(ExecutionStatus.Paused);

      await app.cancel(paused.threadId, { tenantId: "acme" });

      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([
        {
          orderId: "A",
          reason: PauseClosedReason.Cancelled,
          executionId: paused.pending[0]?.childExecutionId,
          agent: "child-refund-agent",
        },
      ]);
    },
  );

  desk(
    "AC2: app.cancel while a sibling still runs: the tree ends, the pause is Cancelled",
    async ({ app, mockLlm }) => {
      mockLlm(AuditRefundAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      mockLlm(AuditCheckAgent).thenReturn(waitFor(seconds(60)), failWith(ModelFailure.Timeout));
      const run = execute(app, AuditWorkflowStart, { orderId: "7" }, ACME);
      run.catch(() => undefined);
      await until(() => seen.asks.length === 1);

      await app.cancel(ACME.threadId, { tenantId: "acme" });

      await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([{ orderId: "7", reason: PauseClosedReason.Cancelled }]);
    },
  );

  desk("AC2: a pause never sent (its send threw) → no notice", async ({ app, mockLlm }) => {
    hooks.refusals = new Map([["7", new Error("the desk is closed")]]);
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));

    await expect(execute(app, DeskWorkflowStart, REFUND, ACME)).rejects.toThrow();

    const pauses = await pauseStore().findAllByTenantIdAndRootExecutionId("acme", "execution-1");
    expect(pauses).toMatchObject([{ status: PauseStatus.Cancelled, isSent: false }]);
    expect(await pauseStore().countNotices()).toEqual({ live: 0, dead: 0 });
    expect(seen.closed).toEqual([]);
    expect(seen.heard).toEqual([]);
  });

  desk(
    "AC2: closed while send returned: the listeners hear opened then closed, the channel closed — once each",
    async ({ app, clock, mockLlm }) => {
      hooks.beforeSendReturns = async (sent) => {
        await pauseStore().cancelByTenantIdAndPauseId(
          "acme",
          sent.pauseId,
          PauseResolution.Withdrawn,
          clock.now(),
          NO_RECIPIENTS,
        );
      };
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));

      await expect(execute(app, DeskWorkflowStart, REFUND, ACME)).rejects.toThrow();

      await until(() => seen.closed.length === 1 && seen.heard.length === 4);
      expect(seen.closed).toMatchObject([
        { orderId: "7", reason: PauseClosedReason.Withdrawn, agent: "desk-clerk-agent" },
      ]);
      const audit = seen.heard.filter((one) => one.listener === "audit");
      expect(audit.map((one) => one.type)).toEqual(["opened", "closed"]);
    },
  );

  twoInstances(
    "AC2: two instances cancel at once: the channel is told once",
    async ({ apps, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      const paused = await execute(first, DeskWorkflowStart, REFUND, ACME);

      await Promise.allSettled([
        first.cancel(paused.threadId, { tenantId: "acme" }),
        second.cancel(paused.threadId, { tenantId: "acme" }),
      ]);

      await until(() => seen.closed.length >= 1);
      await Promise.all(apps.map((one) => one.close()));
      expect(seen.closed).toHaveLength(1);
      const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
      expect(stored?.status).toBe(PauseStatus.Cancelled);
    },
  );
});

describe("#940 Q2: an answer recorded and never applied", () => {
  desk(
    "AC2: the drain took the answer, a cancel ended the tree before the step: closed answered, then answerNotTaken cancelled with the answer — to the channel and the listeners",
    async ({ app, clock, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      await execute(app, DeskWorkflowStart, REFUND, ACME);
      const pauseId = askFor("7").pauseId;
      const recipients = {
        channel: "refund-approval-channel",
        listeners: ["audit-pause-listener", "trusted-pause-listener"],
      };
      const answer = { decision: { approved: true }, answeredBy: "manager-17" };
      // the answer is recorded; the cancel closes it before its step took it
      await pauseStore().resolveByTenantIdAndPauseId(
        "acme",
        pauseId,
        answer,
        clock.now(),
        recipients,
      );
      await pauseStore().closeUntakenByTenantIdAndPauseId(
        "acme",
        pauseId,
        PauseResolution.Cancelled,
        clock.now(),
        recipients,
      );

      await clock.advance(seconds(5));

      await until(() => seen.closed.length === 1 && seen.notTaken.length === 1);
      expect(seen.closed).toMatchObject([
        {
          reason: PauseClosedReason.Answered,
          answeredBy: "manager-17",
          answer: { approved: true },
        },
      ]);
      expect(seen.notTaken).toMatchObject([
        { reason: PauseClosedReason.Cancelled, answer: { approved: true } },
      ]);
      await until(() => seen.heard.filter((one) => one.listener === "audit").length === 3);
      const audit = seen.heard.filter((one) => one.listener === "audit");
      expect(audit.map((one) => one.type)).toEqual(["opened", "closed", "answer-not-taken"]);
      // each notice its own id, the channel's differs from the listener's
      expect(new Set(audit.map((one) => one.event.deliveryId)).size).toBe(3);
    },
  );
});

describe("#940 AC4: a failing receiver changes nothing else", () => {
  panel("AC4: the join goes on: the quorum's execution finishes", async ({ app, mockLlm }) => {
    hooks.closeFailure = new Error("slack is down");
    mockLlm(PolicyAgent).thenReturn(score(7));
    mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    mockLlm(FraudAgent).thenReturn(score(9));

    const result = await execute(app, RefundPanelWorkflowStart, { orderId: "7" });

    expect(result).toFinishWith(RefundDecidedWorkflowFinish, { text: "7, 9" });
    await until(() => failedNotices().length === 1);
    expect(seen.closed).toHaveLength(1);
    expect(failedNotices()).toMatchObject([
      { message: expect.stringContaining("receiver-failed"), tenantId: "default" },
    ]);
  });

  testWith(PayoutsApplication)(
    "AC4: .onJoinError goes on: the failed branch's handler finishes the execution",
    async ({ app, clock, mockLlm }) => {
      hooks.closeFailure = new Error("the customer's app is offline");
      hooks.refusals = new Map([["7", new PaymentDeclinedError("the card was declined")]]);
      mockLlm(PayoutConfirmAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
      mockLlm(PayoutRefundAgent).thenReturn(
        waitFor(seconds(5)),
        callTool(RefundTool, { orderId: "7" }),
      );
      const run = execute(app, PayoutWorkflowStart, { orderId: "7" });
      run.catch(() => undefined);
      await until(() => seen.confirmations.length === 1);

      await clock.advance(seconds(5));

      expect(await run).toFinishWith(PayoutDeclinedWorkflowFinish, { text: "declined 7" });
      await until(() => seen.closed.length === 1);
      expect(seen.closed).toMatchObject([
        { channel: "customer", reason: PauseClosedReason.Withdrawn },
      ]);
    },
  );

  desk("AC4: app.cancel goes on", async ({ app, mockLlm }) => {
    hooks.closeFailure = new Error("slack is down");
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

    await app.cancel(paused.threadId, { tenantId: "acme" });

    const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
    expect(stored?.status).toBe(PauseStatus.Cancelled);
    await until(() => failedNotices().length === 1);
  });
});
