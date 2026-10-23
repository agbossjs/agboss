/**
 * #396 PR 8 — a case drafted from what an execution did: its start's input as the case's turn, its
 * contexts, its thread's earlier finished turns as the history, the calls it ran (each tool with
 * the same arguments once, none it never ran) as the required calls.
 */
import { describe, expect, it } from "vitest";
import { evalCaseDraftOf, observedExecutionOf } from "../../src/eval/case-from-execution.js";
import { ExecutionHistoryStatus } from "../../src/infrastructure/execution-history.repository.js";
import { historyRecordOf, REFUND_THREAD } from "./fixtures/history-records.js";

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
        { tool: "get-order-tool", arguments: { orderId: "7" } },
        { tool: "refund-tool", arguments: { orderId: "7", amountCents: 5000 } },
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
});
