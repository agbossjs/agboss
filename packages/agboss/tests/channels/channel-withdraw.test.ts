/**
 * #337 AC2 / AC3: a channel's `withdraw` takes back the question of a pause it sent
 * (`ChannelOutcome.awaitReply()`) once that pause closes without an answer — `Withdrawn` (a decided
 * quorum, a `FailFast` sibling) or `Cancelled` (`app.cancel`, the tree's end) — exactly once, in
 * the pause's execution frame, under its tool's `timeout`; never for a pause it decided at once or
 * never sent. A `withdraw` that throws or hangs is a `channel.withdraw-failed` warning and nothing
 * else: the join, `.onJoinError` and `app.cancel` go on.
 */
import { beforeEach, describe, expect } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  ChannelOutcome,
  ExecutionCancelledError,
  LogLevel,
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
import { askFor, until } from "./fixtures/pause-scripts.js";
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
  FinanceDeskRefundApprovalChannel,
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

/** The warnings of withdrawals that failed. */
const failedWithdrawals = () => logged.filter((entry) => entry.code === "channel.withdraw-failed");

describe("#337 AC2: withdraw is called once when a sent pause closes without an answer", () => {
  panel(
    "a decided quorum: the surplus branch's pause is withdrawn, its channel told once",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(FinanceDeskRefundApprovalChannel).send.mockResolvedValue(ChannelOutcome.awaitReply());
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
      // the desk's question about the surplus branch, taken back once
      expect(mockOf(FinanceDeskRefundApprovalChannel).withdraw.mock.calls).toEqual([
        [
          {
            pauseId: expect.stringMatching(/^[0-9a-f]{32}$/),
            value: expect.objectContaining({ tool: "refund-tool", arguments: { orderId: "7" } }),
            resolution: PauseResolution.Withdrawn,
          },
        ],
      ]);
    },
  );

  desk(
    "a FailFast sibling: Withdrawn, in the pause's execution and step",
    async ({ app, clock, mockLlm }) => {
      mockLlm(AuditRefundAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      mockLlm(AuditCheckAgent).thenReturn(waitFor(seconds(5)), failWith(ModelFailure.Timeout));
      const run = execute(app, AuditWorkflowStart, { orderId: "7" }, ACME);
      run.catch(() => undefined);
      await until(() => seen.asks.length === 1);

      await clock.advance(seconds(5));

      await expect(run).rejects.toThrow();
      const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
      expect(seen.withdrawals).toEqual([
        {
          channel: "finance-desk",
          pauseId: askFor("7").pauseId,
          orderId: "7",
          resolution: PauseResolution.Withdrawn,
          executionId: stored?.executionId,
          tenantId: "acme",
          agent: "audit-refund-agent",
        },
      ]);
    },
  );

  desk(
    "app.cancel of a paused execution: Cancelled, in the pause's frame",
    async ({ app, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);
      expect(paused.status).toBe(ExecutionStatus.Paused);

      await app.cancel(paused.threadId, { tenantId: "acme" });

      expect(seen.withdrawals).toMatchObject([
        {
          orderId: "7",
          resolution: PauseResolution.Cancelled,
          executionId: paused.executionId,
          tenantId: "acme",
          agent: "desk-clerk-agent",
        },
      ]);
    },
  );

  testWith(ChildPausesApplication)(
    "app.cancel of a pause inside a child: told in the child's execution",
    async ({ app, mockLlm }) => {
      mockLlm(ChildRefundAgent).thenReturn(callTool(RefundTool, { orderId: "A" }));
      const paused = await execute(app, SingleChildWorkflowStart, { orderId: "A" }, ACME);
      expect(paused.status).toBe(ExecutionStatus.Paused);

      await app.cancel(paused.threadId, { tenantId: "acme" });

      expect(seen.withdrawals).toMatchObject([
        {
          orderId: "A",
          resolution: PauseResolution.Cancelled,
          executionId: paused.pending[0]?.childExecutionId,
          agent: "child-refund-agent",
        },
      ]);
    },
  );

  desk(
    "app.cancel while a sibling still runs: the tree ends, the pause is Cancelled",
    async ({ app, mockLlm }) => {
      mockLlm(AuditRefundAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      mockLlm(AuditCheckAgent).thenReturn(waitFor(seconds(60)), failWith(ModelFailure.Timeout));
      const run = execute(app, AuditWorkflowStart, { orderId: "7" }, ACME);
      run.catch(() => undefined);
      await until(() => seen.asks.length === 1);

      await app.cancel(ACME.threadId, { tenantId: "acme" });

      await expect(run).rejects.toBeInstanceOf(ExecutionCancelledError);
      expect(seen.withdrawals).toMatchObject([
        { orderId: "7", resolution: PauseResolution.Cancelled },
      ]);
    },
  );

  desk("not for a pause never sent: its send threw, the tree ended", async ({ app, mockLlm }) => {
    hooks.refusals = new Map([["7", new Error("the desk is closed")]]);
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));

    await expect(execute(app, DeskWorkflowStart, REFUND, ACME)).rejects.toThrow();

    // the test's ids are sequential: the execution is `execution-1`
    const pauses = await pauseStore().findAllByTenantIdAndRootExecutionId("acme", "execution-1");
    expect(pauses).toMatchObject([{ status: PauseStatus.Cancelled, isSent: false }]);
    expect(seen.withdrawals).toEqual([]);
  });

  desk(
    "send returned after its pause was withdrawn: the step itself tells the channel",
    async ({ app, clock, mockLlm }) => {
      hooks.beforeSendReturns = async (sent) => {
        await pauseStore().cancelByTenantIdAndPauseId(
          "acme",
          sent.pauseId,
          PauseResolution.Withdrawn,
          clock.now(),
        );
      };
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));

      await expect(execute(app, DeskWorkflowStart, REFUND, ACME)).rejects.toThrow();

      expect(seen.withdrawals).toMatchObject([
        { orderId: "7", resolution: PauseResolution.Withdrawn, agent: "desk-clerk-agent" },
      ]);
    },
  );

  twoInstances(
    "two instances cancel at once: the channel is told once",
    async ({ apps, mockLlm }) => {
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const [first, second] = apps;
      if (first === undefined || second === undefined) throw new Error("two instances expected");
      const paused = await execute(first, DeskWorkflowStart, REFUND, ACME);

      await Promise.allSettled([
        first.cancel(paused.threadId, { tenantId: "acme" }),
        second.cancel(paused.threadId, { tenantId: "acme" }),
      ]);

      expect(seen.withdrawals).toHaveLength(1);
      const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
      expect(stored?.status).toBe(PauseStatus.Cancelled);
    },
  );
});

describe("#337 AC3: a failing withdraw is logged and changes nothing else", () => {
  panel("the join goes on: the quorum's execution finishes", async ({ app, mockLlm }) => {
    hooks.withdrawFailure = new Error("slack is down");
    mockLlm(PolicyAgent).thenReturn(score(7));
    mockLlm(RiskAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    mockLlm(FraudAgent).thenReturn(score(9));

    const result = await execute(app, RefundPanelWorkflowStart, { orderId: "7" });

    expect(result).toFinishWith(RefundDecidedWorkflowFinish, { text: "7, 9" });
    expect(seen.withdrawals).toHaveLength(1);
    expect(failedWithdrawals()).toMatchObject([
      { level: LogLevel.Warn, message: expect.stringContaining("slack is down") },
    ]);
  });

  testWith(PayoutsApplication)(
    ".onJoinError goes on: the failed branch's handler finishes the execution",
    async ({ app, clock, mockLlm }) => {
      hooks.withdrawFailure = new Error("the customer's app is offline");
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
      expect(seen.withdrawals).toMatchObject([
        { channel: "customer", resolution: PauseResolution.Withdrawn },
      ]);
    },
  );

  desk("app.cancel goes on", async ({ app, mockLlm }) => {
    hooks.withdrawFailure = new Error("slack is down");
    mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
    const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

    await app.cancel(paused.threadId, { tenantId: "acme" });

    const stored = await pauseStore().findByTenantIdAndPauseId("acme", askFor("7").pauseId);
    expect(stored?.status).toBe(PauseStatus.Cancelled);
    expect(failedWithdrawals()).toHaveLength(1);
  });

  desk(
    "a withdraw past its tool's timeout is cut off and logged",
    async ({ app, clock, mockLlm }) => {
      hooks.withdrawWait = () => new Promise<void>(() => undefined);
      mockLlm(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, REFUND, ACME);

      const cancelled = app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.withdrawals.length === 1);
      await clock.advance(seconds(30));
      await cancelled;

      expect(failedWithdrawals()).toMatchObject([
        { message: expect.stringContaining("timed out after 30 s"), tenantId: "acme" },
      ]);
    },
  );
});
