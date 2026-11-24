import { buildCostReport } from "../../../src/finops/usage.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import { ToolCallStatus, type ToolCallRecord } from "../../../src/flow/runtime/tool-calls.js";
import {
  ExecutionHistoryStatus,
  type ExecutionHistoryRecord,
} from "../../../src/infrastructure/execution-history.repository.js";

/**
 * #396 PR 8 — kept executions of the refunds desk (`eval-desk.fixture.ts`), as the history keeps
 * them: what a case is drafted from.
 */

/** One call the desk agent made. */
export function toolCallOf(
  tool: string,
  input: unknown,
  status: ToolCallStatus = ToolCallStatus.Succeeded,
): ToolCallRecord {
  return {
    step: {
      component: bareRecordOf(tool, ComponentKind.Tool),
      nodeId: "desk-agent",
      visitNumber: 1,
      idempotencyKey: `e1:desk-agent:1:${tool}`,
      callId: `call-${tool}`,
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: 1,
      validationAttempts: 0,
    },
    input,
    output: { status: "done" },
    status,
    isResultTruncated: false,
    startedAt: "2026-01-05T09:00:01.000Z",
    endedAt: "2026-01-05T09:00:02.000Z",
  };
}

/** A kept turn of thread `thread-1` of tenant acme. */
export function historyRecordOf(
  executionId: string,
  fields: Partial<ExecutionHistoryRecord> = {},
): ExecutionHistoryRecord {
  return {
    path: ["desk-workflow-start", "desk-agent", "desk-workflow-finish"],
    scope: [],
    outdatedValues: [],
    spend: buildCostReport([]),
    children: [],
    pauses: [],
    compensations: [],
    toolCalls: [],
    steps: [],
    executionId,
    rootExecutionId: executionId,
    threadId: "thread-1",
    tenantId: "acme",
    application: { name: "sqlite-history-application", version: "1.0.0", instanceId: "i-1" },
    workflow: {
      name: "eval-desk-workflow",
      version: "1.0.0",
      startedVersion: "1.0.0",
      configHash: "c",
    },
    status: ExecutionHistoryStatus.Finished,
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:00:05.000Z",
    start: bareRecordOf("desk-workflow-start", ComponentKind.WorkflowStart),
    input: { text: "Refund order 7 for <email>" },
    finish: bareRecordOf("desk-workflow-finish", ComponentKind.WorkflowFinish),
    output: { text: "Refunded order 7." },
    contexts: { tenant: { tenantId: "acme", plan: "pro" }, execution: { userId: "u-1" } },
    ...fields,
  };
}

/** A thread of two turns: order 7 asked about, then refunded (the one a case is made from). */
export const REFUND_THREAD: readonly ExecutionHistoryRecord[] = [
  historyRecordOf("e0", {
    startedAt: "2026-01-05T08:00:00.000Z",
    input: { text: "Where is order 7?" },
    output: { text: "Order 7 arrived broken." },
  }),
  historyRecordOf("e1", {
    startedAt: "2026-01-05T09:00:00.000Z",
    toolCalls: [
      toolCallOf("get-order-tool", { orderId: "7" }),
      toolCallOf("get-order-tool", { orderId: "7" }),
      toolCallOf("refund-tool", { orderId: "7", amountCents: 5000 }),
      toolCallOf("delete-order-tool", { orderId: "7" }, ToolCallStatus.Declined),
    ],
  }),
  historyRecordOf("e2", { startedAt: "2026-01-05T10:00:00.000Z", input: { text: "Thanks" } }),
];
