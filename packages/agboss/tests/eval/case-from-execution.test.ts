/**
 * #396 PR 8 — a case drafted from what an execution did: its start's input as the case's turn, its
 * contexts, its thread's earlier finished turns as the history, the calls it ran (each tool with
 * the same arguments once, none it never ran) as the required calls.
 */
import { describe, expect, it } from "vitest";
import { evalCaseDraftOf, observedExecutionOf } from "../../src/eval/case-from-execution.js";
import { ExecutionStatus } from "../../src/app/types.js";
import { PauseResolution } from "../../src/infrastructure/pause-record.js";
import { bareRecordOf, ComponentKind } from "../../src/flow/runtime/records.js";
import { ExecutionHistoryStatus } from "../../src/infrastructure/execution-history.repository.js";
import { historyRecordOf, REFUND_THREAD } from "./fixtures/history-records.js";
import { PauseRespondent } from "../../src/pause/respondent.js";

const [first, refund] = REFUND_THREAD;

describe("#396 PR 8: a case drafted from a kept execution", () => {
  it("its input, contexts, the earlier finished turns and the calls it ran", () => {
    if (refund === undefined) throw new Error("the fixture has the refund");

    const draft = evalCaseDraftOf("refund-from-prod", observedExecutionOf(refund, REFUND_THREAD));

    expect(draft).toEqual({
      name: "refund-from-prod",
      start: "desk-workflow-start",
      tenant: { tenantId: "acme", plan: "pro" },
      execution: { userId: "u-1" },
      history: [
        {
          start: "desk-workflow-start",
          input: { text: "Where is order 7?" },
          finish: "desk-workflow-finish",
          output: { text: "Order 7 arrived broken." },
        },
      ],
      turns: [{ input: { text: "Refund order 7 for <email>" } }],
      required: [
        { tool: "get-order-tool", input: { orderId: "7" } },
        { tool: "refund-tool", input: { orderId: "7", amountCents: 5000 } },
      ],
    });
  });

  it("a turn that did not finish is no past turn; the default tenant and no fields say nothing", () => {
    const failed = historyRecordOf("e0", {
      status: ExecutionHistoryStatus.Failed,
      startedAt: "2026-01-05T08:00:00.000Z",
    });
    const alone = historyRecordOf("e1", {
      tenantId: "default",
      contexts: { tenant: { tenantId: "default" }, execution: {} },
    });

    const draft = evalCaseDraftOf("alone", observedExecutionOf(alone, [failed, alone]));

    expect(draft.history).toEqual([]);
    expect(draft).not.toHaveProperty("tenant");
    expect(draft).not.toHaveProperty("execution");
    expect(first?.status).toBe(ExecutionHistoryStatus.Finished);
  });

  it("the pauses a person answered are the turn's answers; a stopped or cancelled run expects its end", () => {
    const pause = (resolution: PauseResolution, decision: unknown) => ({
      pauseId: "p-1",
      executionId: "e5",
      step: {
        component: bareRecordOf("refund-tool", ComponentKind.Tool),
        nodeId: "desk-agent",
        visitNumber: 1,
        idempotencyKey: "e5:desk-agent:1:call-1",
        callId: "call-1",
        itemIndex: undefined,
        copyNumber: 1,
        toolLoopIteration: 1,
        validationAttempts: 0,
      },
      target: "refund-approval-tool-approval",
      channel: "refund-approval",
      respondent: PauseRespondent.Owner,
      actor: { id: "alice" },
      resolution,
      askedAt: "2026-01-05T09:00:02.000Z",
      resolvedAt: "2026-01-05T09:00:03.000Z",
      decision,
      input: {},
      trail: [],
    });
    const cancelled = historyRecordOf("e5", {
      status: ExecutionHistoryStatus.Cancelled,
      pauses: [
        pause(PauseResolution.Replied, { approved: true }),
        pause(PauseResolution.Decided, { approved: false }),
        pause(PauseResolution.Withdrawn, undefined),
      ],
    });

    const draft = evalCaseDraftOf("cancelled", observedExecutionOf(cancelled, [cancelled]));

    expect(draft.turns).toEqual([
      {
        input: { text: "Refund order 7 for <email>" },
        pauses: [
          {
            target: "refund-approval-tool-approval",
            decision: { approved: true },
            actor: { id: "actor-1" },
          },
        ],
      },
    ]);
    expect(draft.expectedStatus).toBe(ExecutionStatus.Cancelled);
    const failed = historyRecordOf("e6", { status: ExecutionHistoryStatus.Failed });
    expect(evalCaseDraftOf("failed", observedExecutionOf(failed, [failed]))).not.toHaveProperty(
      "expectedStatus",
    );
  });

  it("the person who answered is a placeholder, one per person; a tokenized decision keeps its token only", () => {
    const base = historyRecordOf("e7", {});
    const answer = (actor: string, decision: unknown) => ({
      pauseId: "p-2",
      executionId: "e7",
      step: {
        component: bareRecordOf("refund-tool", ComponentKind.Tool),
        nodeId: "desk-agent",
        visitNumber: 1,
        idempotencyKey: "e7:desk-agent:1:call-1",
        callId: "call-1",
        itemIndex: undefined,
        copyNumber: 1,
        toolLoopIteration: 1,
        validationAttempts: 0,
      },
      target: "refund-approval-tool-approval",
      channel: "refund-approval",
      respondent: PauseRespondent.Owner,
      actor: { id: actor },
      resolution: PauseResolution.Replied,
      askedAt: "2026-01-05T09:00:02.000Z",
      resolvedAt: "2026-01-05T09:00:03.000Z",
      decision,
      input: {},
      trail: [],
    });
    const record = {
      ...base,
      pauses: [
        answer("alice@example.com", { note: "<email:7f3a91>" }),
        answer("bob", { note: "ok" }),
        answer("alice@example.com", { note: "again" }),
      ],
    };

    const draft = evalCaseDraftOf("who", observedExecutionOf(record, [record]));

    expect(draft.turns[0]?.pauses?.map((each) => each.actor?.id)).toEqual([
      "actor-1",
      "actor-2",
      "actor-1",
    ]);
    const text = JSON.stringify(draft);
    expect(text).not.toContain("alice");
    expect(text).not.toContain("bob");
    expect(text).toContain("<email:7f3a91>");
  });
});
