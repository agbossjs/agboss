/**
 * #267 S107 (built in PR 3): who answered each pause is in the execution record —
 * `ExecutionRecord.pauses`, in the order asked, one `PauseResolution` each (`Replied`, `Decided`,
 * `Withdrawn`, `Cancelled`), the decision masked by the application's PII policies and none for a
 * pause closed without an answer, no `pauseId` for a `PauseAnswerer.Channel` pause. Resolved records
 * are kept `@Application({ pauseRecordRetention })` (default `hours(24)`) and then removed by the
 * recovery sweep on the `Clock`: within it a late answer is `NotPausedError`, after it
 * `UnknownPauseError`; a pending pause is never removed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import {
  AutoApproveChannel,
  NotPausedError,
  PauseAnswerer,
  PauseResolution,
  PauseStatus,
  UnknownPauseError,
} from "../../src/index.js";
import { callTool, override, replyWith, testWith, waitFor } from "../../src/testing/index.js";
import { TEST_START } from "../../src/testing/clock.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import {
  BookExpenseTool,
  BriefTreasuryApplication,
  PayOutTool,
  replyDesk,
  resetReplyDesk,
  TransferApprovalChannel,
  TransferTool,
  TreasurerAgent,
  TreasuryApplication,
  TreasuryWorkflowStart,
  treasuryPauses,
} from "../flow/fixtures/replies.fixture.js";
import { execute } from "../helpers/flow.js";
import {
  PaymentDeclinedError,
  PayoutConfirmAgent,
  PayoutRefundAgent,
  PayoutsApplication,
  PayoutWorkflowStart,
} from "./fixtures/payouts.workflow.js";
import {
  ConfirmOrderTool,
  hooks,
  RefundTool,
  resetPauses,
  seen,
} from "./fixtures/pauses.workflow.js";
import { until } from "./fixtures/pause-scripts.js";

beforeEach(() => {
  resetReplyDesk();
  resetPauses();
});

const manager = { answeredBy: "manager-17" };

/** The finance desk's only ask: its pause's id is the reply key. */
function payoutPauseId(): string {
  const [ask] = replyDesk.asks;
  if (ask === undefined) throw new Error("the desk was not asked");
  return ask.pauseId;
}

describe("#267 S107: ExecutionRecord.pauses — who answered each pause, and how", () => {
  testWith(TreasuryApplication)(
    "a pause answered through its channel: Replied, its responder and times, the decision masked, no id",
    async ({ app, clock, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(
        callTool(PayOutTool, { payee: "ann", amountCents: 1000 }),
        replyWith("Refused."),
      );
      await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
      await clock.advance(minutes(1));

      const done = await app.resume(
        { pauseId: payoutPauseId(), decision: { approved: false, reason: "ask ann@example.com" } },
        { ...manager, record: true },
      );

      expect(done.record?.pauses).toEqual([
        {
          pauseId: undefined,
          executionId: done.runId,
          step: {
            component: { name: "treasurer-agent" },
            nodeId: "treasurer-agent",
            visitNumber: 1,
            idempotencyKey: `${done.runId}:treasurer-agent:1:call-1`,
            callId: "call-1",
            itemIndex: undefined,
            copyNumber: 1,
          },
          role: "payout-approval-channel",
          answeredBy: PauseAnswerer.Channel,
          responder: "manager-17",
          resolution: PauseResolution.Replied,
          askedAt: TEST_START,
          resolvedAt: "2026-01-05T09:01:00.000Z",
          decision: { approved: false, reason: "ask <email>" },
        },
      ]);
    },
  );

  testWith(TreasuryApplication)(
    "a pending pause is not in the record: it is in result.pending",
    async ({ app, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1 }));

      const paused = await execute(
        app,
        TreasuryWorkflowStart,
        { text: "pay ann" },
        { record: true },
      );

      expect(paused.record?.pauses).toEqual([]);
      expect(paused.pending).toHaveLength(1);
    },
  );

  testWith(TreasuryApplication)(
    "a thread owner's pause answered with a reply: its id and the owner; the interpreter's decision",
    async ({ app, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(
        callTool(BookExpenseTool, { purpose: "lunch" }),
        replyWith("Booked."),
      );
      const paused = await execute(
        app,
        TreasuryWorkflowStart,
        { text: "book lunch" },
        { ownerId: "alice" },
      );
      const pauseId = paused.pending[0]?.pauseId;

      const done = await app.resume(
        { pauseId: pauseId ?? "", reply: '{"approved":true}' },
        { ownerId: "alice", record: true },
      );

      expect(done.record?.pauses).toMatchObject([
        {
          pauseId,
          role: "expense-approval-channel",
          answeredBy: PauseAnswerer.ThreadOwner,
          responder: "alice",
          resolution: PauseResolution.Replied,
          decision: { approved: true },
        },
      ]);
    },
  );

  testWith(TreasuryApplication, {
    overrides: [override(TransferApprovalChannel, AutoApproveChannel)],
  })(
    "a pause its channel decided at once: Decided, no responder, the channel's decision",
    async ({ app, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(
        callTool(TransferTool, { account: "DE-1" }),
        replyWith("Transferred."),
      );

      const done = await execute(
        app,
        TreasuryWorkflowStart,
        { text: "transfer" },
        { record: true },
      );

      expect(done.record?.pauses).toMatchObject([
        {
          pauseId: undefined,
          role: "transfer-approval-channel",
          responder: undefined,
          resolution: PauseResolution.Decided,
          resolvedAt: TEST_START,
          decision: { approved: true },
        },
      ]);
    },
  );

  testWith(PayoutsApplication)(
    "a FailFast sibling failed: the paused branch's pause is Withdrawn, the failed one's Cancelled with the tree — no decision",
    async ({ app, clock, mockLlm }) => {
      hooks.refusals = new Map([["7", new PaymentDeclinedError("the card was declined")]]);
      mockLlm(PayoutConfirmAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
      mockLlm(PayoutRefundAgent).thenReturn(
        waitFor(seconds(5)),
        callTool(RefundTool, { orderId: "7" }),
      );
      const run = execute(app, PayoutWorkflowStart, { orderId: "7" }, { record: true });
      await until(() => seen.confirmations.length === 1);
      await clock.advance(seconds(5));

      const done = await run;

      expect(done.record?.pauses).toMatchObject([
        {
          pauseId: seen.confirmations[0]?.pauseId,
          role: "order-confirmation-channel",
          responder: undefined,
          resolution: PauseResolution.Withdrawn,
          decision: undefined,
        },
        {
          pauseId: undefined,
          role: "refund-approval-channel",
          resolution: PauseResolution.Cancelled,
          decision: undefined,
        },
      ]);
    },
  );

  testWith(TreasuryApplication)(
    "app.cancel of a paused thread: its pause is Cancelled",
    async ({ app, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1 }));
      const paused = await execute(app, TreasuryWorkflowStart, { text: "pay ann" });

      await app.cancel(paused.threadId);

      const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
      expect(stored).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Cancelled,
        resolvedAt: TEST_START,
      });
      expect(stored?.answer).toBeUndefined();
    },
  );
});

describe("#267 S107: resolved pause records are kept pauseRecordRetention, then removed", () => {
  testWith(BriefTreasuryApplication)(
    "within it a late answer is NotPausedError, after it UnknownPauseError; a pending pause stays",
    async ({ app, clock, mockLlm }) => {
      mockLlm(TreasurerAgent)
        .when({ message: { text: "pay ann" } })
        .thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1 }), replyWith("Paid."));
      mockLlm(TreasurerAgent)
        .when({ message: { text: "book lunch" } })
        .thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }), replyWith("Booked."));
      await execute(app, TreasuryWorkflowStart, { text: "pay ann" });
      const waiting = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });
      const answer = { pauseId: payoutPauseId(), decision: { approved: true } };
      await app.resume(answer, manager);

      await clock.advance(minutes(4));
      await expect(app.resume(answer, manager)).rejects.toBeInstanceOf(NotPausedError);
      await clock.advance(minutes(2));
      await expect(app.resume(answer, manager)).rejects.toBeInstanceOf(UnknownPauseError);

      const expense = { pauseId: waiting.pending[0]?.pauseId ?? "", decision: { approved: true } };
      expect(await app.resume(expense)).toMatchObject({ pending: [] });
    },
  );

  testWith(BriefTreasuryApplication)(
    "the record keeps a pause whose record the retention removed: record.pauses is the permanent log",
    async ({ app, clock, mockLlm }) => {
      mockLlm(TreasurerAgent).thenReturn(
        callTool(PayOutTool, { payee: "ann", amountCents: 1 }),
        callTool(BookExpenseTool, { purpose: "lunch" }),
        replyWith("Paid and booked."),
      );
      await execute(app, TreasuryWorkflowStart, { text: "pay ann, book lunch" });
      const payout = { pauseId: payoutPauseId(), decision: { approved: true } };
      const waiting = await app.resume(payout, manager);
      await clock.advance(minutes(6));
      await expect(app.resume(payout, manager)).rejects.toBeInstanceOf(UnknownPauseError);

      const expense = { pauseId: waiting.pending[0]?.pauseId ?? "", decision: { approved: true } };
      const done = await app.resume(expense, { record: true });

      expect(done.record?.pauses.map((pause) => [pause.role, pause.resolution])).toEqual([
        ["payout-approval-channel", PauseResolution.Replied],
        ["expense-approval-channel", PauseResolution.Replied],
      ]);
      expect(done.record?.pauses[0]).toMatchObject({
        responder: "manager-17",
        askedAt: TEST_START,
      });
    },
  );

  it("the default retention is hours(24)", async () => {
    const assembled = await applicationOf(TreasuryApplication);

    expect(assembled.pauseRecordRetention).toBe(hours(24));
  });
});
