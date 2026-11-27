/**
 * #267 S107 (built in PR 3): who answered each pause is in the execution record —
 * `ExecutionRecord.pauses`, in the order asked, one `PauseResolution` each (`Replied`, `Decided`,
 * `Withdrawn`, `Cancelled`), the decision masked by the application's PII policies and none for a
 * pause closed without an answer, no `pauseId` for a `PauseRespondent.Delegate` pause. Resolved records
 * are kept `@Application({ retention: { pauseRecords } })` (default `hours(24)`) and then removed by the
 * recovery sweep on the `Clock`: within it a late answer is `PauseError.Closed`, after it
 * `PauseError.UnknownPause`; a pending pause is never removed.
 */
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { NO_RECIPIENTS } from "../../src/infrastructure/pause-notices.js";
import { ComponentKind } from "../../src/flow/runtime/records.js";
import { beforeEach, describe, expect, it } from "vitest";
import { AutoApproveChannel } from "../../src/testing/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import { PauseRespondent, PauseResolution, PauseStatus } from "../../src/index.js";
import { callTool, replyWith, testWith, waitFor } from "../../src/testing/index.js";
import { TEST_START } from "../../src/testing/clock.js";
import { hours, minutes, seconds } from "../../src/units/index.js";
import {
  BookExpenseTool,
  BriefTreasuryApplication,
  PayOutTool,
  replyDesk,
  resetReplyDesk,
  TransferToolApproval,
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

const manager = { actor: { id: "manager-17" } };

/** The finance desk's only ask: its pause's id is the reply key. */
function payoutPauseId(): string {
  const [ask] = replyDesk.asks;
  if (ask === undefined) throw new Error("the desk was not asked");
  return ask.pauseId;
}

describe("#267 S107: ExecutionRecord.pauses — who answered each pause, and how", () => {
  testWith(TreasuryApplication)(
    "a pause answered through its channel: Replied, its responder and times, the decision masked, no id",
    async ({ app, clock, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(
        callTool(PayOutTool, { payee: "ann", amountCents: 1000 }),
        replyWith("Refused."),
      );
      await execute(app, TreasuryWorkflowStart, { text: "pay ann $10" });
      await clock.advance(minutes(1));

      const done = await app.resume(
        { pauseId: payoutPauseId(), decision: { approved: false, reason: "ask ann@example.com" } },
        { ...manager, includeRecord: true },
      );

      expect(done.record?.pauses).toEqual([
        {
          pauseId: undefined,
          executionId: done.executionId,
          step: {
            component: {
              name: "treasurer-agent",
              kind: ComponentKind.Agent,
              promptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
              schemaHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            },
            nodeId: "treasurer-agent",
            visitNumber: 1,
            idempotencyKey: `${done.executionId}:treasurer-agent:1:call-1`,
            callId: "call-1",
            itemIndex: undefined,
            copyNumber: 1,
            toolLoopIteration: 1,
            validationAttempts: 0,
          },
          target: "payout-tool-approval",
          channel: "desk-payout-approval-channel",
          respondent: PauseRespondent.Delegate,
          actor: { id: "manager-17" },
          resolution: PauseResolution.Replied,
          askedAt: new Date(TEST_START),
          resolvedAt: new Date("2026-01-05T09:01:00.000Z"),
          decision: { approved: false, reason: "ask <email>" },
          // #688: the call as asked, beside the decision on it
          input: { payee: "ann", amountCents: 1000 },
          toolCall: expect.objectContaining({ tool: "pay-out-tool" }),
          trail: [expect.objectContaining({ action: "opened" })],
        },
      ]);
    },
  );

  testWith(TreasuryApplication)(
    "a pending pause is not in the record: it is in result.pending",
    async ({ app, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1 }));

      const paused = await execute(
        app,
        TreasuryWorkflowStart,
        { text: "pay ann" },
        { includeRecord: true },
      );

      expect(paused.record?.pauses).toEqual([]);
      expect(paused.pending).toHaveLength(1);
    },
  );

  testWith(TreasuryApplication)(
    "a thread owner's pause answered with a reply: its id and the owner; the interpreter's decision",
    async ({ app, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(
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
        { ownerId: "alice", includeRecord: true },
      );

      expect(done.record?.pauses).toMatchObject([
        {
          pauseId,
          target: "expense-tool-approval",
          channel: "button-expense-approval-channel",
          respondent: PauseRespondent.Owner,
          actor: { id: "alice" },
          resolution: PauseResolution.Replied,
          decision: { approved: true },
        },
      ]);
    },
  );

  testWith(TreasuryApplication, {
    services: [AutoApproveChannel.for(TransferToolApproval)],
  })(
    "a pause its channel decided at once: Decided, no responder, the channel's decision",
    async ({ app, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(
        callTool(TransferTool, { account: "DE-1" }),
        replyWith("Transferred."),
      );

      const done = await execute(
        app,
        TreasuryWorkflowStart,
        { text: "transfer" },
        { includeRecord: true },
      );

      expect(done.record?.pauses).toMatchObject([
        {
          pauseId: undefined,
          target: "transfer-tool-approval",
          actor: undefined,
          resolution: PauseResolution.Decided,
          resolvedAt: new Date(TEST_START),
          decision: { approved: true },
        },
      ]);
    },
  );

  testWith(PayoutsApplication)(
    "a FailFast sibling failed: the paused branch's pause is Withdrawn, the failed one's TreeEnded with the tree (a failure, not a cancel) — no decision",
    async ({ app, clock, mockModel }) => {
      hooks.refusals = new Map([["7", new PaymentDeclinedError("the card was declined")]]);
      mockModel(PayoutConfirmAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
      mockModel(PayoutRefundAgent).thenReturn(
        waitFor(seconds(5)),
        callTool(RefundTool, { orderId: "7" }),
      );
      const run = execute(app, PayoutWorkflowStart, { orderId: "7" }, { includeRecord: true });
      await until(() => seen.confirmations.length === 1);
      await clock.advance(seconds(5));

      const done = await run;

      expect(done.record?.pauses).toMatchObject([
        {
          pauseId: seen.confirmations[0]?.pauseId,
          target: "order-confirmation-tool-approval",
          actor: undefined,
          resolution: PauseResolution.Withdrawn,
          decision: undefined,
        },
        {
          pauseId: undefined,
          target: "refund-gate-tool-approval",
          resolution: PauseResolution.TreeEnded,
          decision: undefined,
        },
      ]);
    },
  );

  testWith(TreasuryApplication)(
    "app.cancel of a paused thread: its pause is Cancelled",
    async ({ app, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1 }));
      const paused = await execute(app, TreasuryWorkflowStart, { text: "pay ann" });

      await app.cancel(paused.threadId);

      const stored = await treasuryPauses().findByTenantIdAndPauseId("default", payoutPauseId());
      expect(stored).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Cancelled,
        resolvedAt: new Date(TEST_START),
      });
      expect(stored?.answer).toBeUndefined();
    },
  );
});

describe("#267 S107: resolved pause records are kept retention.pauseRecords, then removed", () => {
  testWith(BriefTreasuryApplication)(
    "within it a late answer is PauseError.Closed, after it PauseError.UnknownPause; a pending pause stays",
    async ({ app, clock, mockModel }) => {
      mockModel(TreasurerAgent)
        .when({ message: { text: "pay ann" } })
        .thenReturn(callTool(PayOutTool, { payee: "ann", amountCents: 1 }), replyWith("Paid."));
      mockModel(TreasurerAgent)
        .when({ message: { text: "book lunch" } })
        .thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }), replyWith("Booked."));
      await execute(app, TreasuryWorkflowStart, { text: "pay ann" });
      const waiting = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });
      const answer = { pauseId: payoutPauseId(), decision: { approved: true } };
      await app.resume(answer, manager);

      await clock.advance(minutes(4));
      await expect(app.resume(answer, manager)).rejects.toBeInstanceOf(PauseError.Closed);
      await clock.advance(minutes(2));
      await expect(app.resume(answer, manager)).rejects.toBeInstanceOf(PauseError.UnknownPause);

      const expense = { pauseId: waiting.pending[0]?.pauseId ?? "", decision: { approved: true } };
      expect(await app.resume(expense)).toMatchObject({ pending: [] });
    },
  );

  testWith(BriefTreasuryApplication)(
    "the record keeps a pause whose record the retention removed: record.pauses is the permanent log",
    async ({ app, clock, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(
        callTool(PayOutTool, { payee: "ann", amountCents: 1 }),
        callTool(BookExpenseTool, { purpose: "lunch" }),
        replyWith("Paid and booked."),
      );
      await execute(app, TreasuryWorkflowStart, { text: "pay ann, book lunch" });
      const payout = { pauseId: payoutPauseId(), decision: { approved: true } };
      const waiting = await app.resume(payout, manager);
      await clock.advance(minutes(6));
      await expect(app.resume(payout, manager)).rejects.toBeInstanceOf(PauseError.UnknownPause);

      const expense = { pauseId: waiting.pending[0]?.pauseId ?? "", decision: { approved: true } };
      const done = await app.resume(expense, { includeRecord: true });

      expect(done.record?.pauses.map((pause) => [pause.target, pause.resolution])).toEqual([
        ["payout-tool-approval", PauseResolution.Replied],
        ["expense-tool-approval", PauseResolution.Replied],
      ]);
      expect(done.record?.pauses[0]).toMatchObject({
        actor: { id: "manager-17" },
        askedAt: new Date(TEST_START),
      });
    },
  );

  it("the default retention is hours(24)", async () => {
    const assembled = await applicationOf(TreasuryApplication);

    expect(assembled.pauseRecordRetention).toBe(hours(24));
  });
});

describe("#939: an unconsumed Resolved pause of an ended tree is closed not taken, then swept", () => {
  testWith(BriefTreasuryApplication)(
    "a pause answered while a cancel wins is Cancelled, its answer kept, the log says not taken, and it is removed after retention.pauseRecords",
    async ({ app, clock, mockModel }) => {
      mockModel(TreasurerAgent).thenReturn(callTool(BookExpenseTool, { purpose: "lunch" }));
      const waiting = await execute(app, TreasuryWorkflowStart, { text: "book lunch" });
      const pauseId = waiting.pending[0]?.pauseId ?? "";
      const pauses = treasuryPauses();
      // a resume recorded its answer and the cancel won before its pass took it (#811 s18c)
      const answer = { decision: { approved: true }, actor: undefined };
      await pauses.resolveByTenantIdAndPauseId(
        waiting.tenantId,
        pauseId,
        answer,
        clock.now(),
        NO_RECIPIENTS,
      );

      await app.cancel(waiting.threadId, { tenantId: waiting.tenantId });

      expect(await pauses.findByTenantIdAndPauseId(waiting.tenantId, pauseId)).toMatchObject({
        status: PauseStatus.Cancelled,
        resolution: PauseResolution.Cancelled,
        answer,
      });
      await clock.advance(minutes(6));
      await expect(app.resume({ pauseId, decision: { approved: true } })).rejects.toBeInstanceOf(
        PauseError.UnknownPause,
      );
    },
  );
});
