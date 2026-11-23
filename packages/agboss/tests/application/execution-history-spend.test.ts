/**
 * #1366: the spend a kept execution record states — what the flow's steps spent (its agent's model calls), so the history of a finished run agrees with its result and the ledger.
 */
import { describe, expect } from "vitest";
import { ExecutionHistoryRepository } from "../../src/index.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import {
  DeskAgent,
  DeskAnswerDto,
  DeskWorkflowStart,
  GetOrderTool,
} from "../flow/fixtures/eval-desk.fixture.js";
import { HistoryDeskApplication } from "../flow/fixtures/execution-history.fixture.js";
import { execute } from "../helpers/flow.js";

const contexts = {
  tenant: { tenantId: "acme", plan: "pro" },
  execution: { userId: "u-1" },
} as const;

describe("#1366: the spend of a kept execution record", () => {
  testWith(HistoryDeskApplication)(
    "is what the run's model calls cost",
    async ({ app, mockLlm }) => {
      mockLlm(DeskAgent).thenReturn(
        callTool(GetOrderTool, { orderId: "7" }),
        replyWith(DeskAnswerDto, { text: "Order 7 shipped." }, { cost: usd(0.25) }),
      );

      const done = await execute(app, DeskWorkflowStart, { text: "Order 7?" }, contexts);
      const kept = await app
        .resolve(ExecutionHistoryRepository)
        .findByTenantIdAndExecutionId("acme", done.executionId);

      expect(done.spend.totalUsd).toBeCloseTo(0.25, 9);
      expect(kept?.spend.totalUsd).toBeCloseTo(0.25, 9);
      expect(kept?.spend.trace.reduce((sum, line) => sum + line.costUsd, 0)).toBeCloseTo(0.25, 9);
    },
  );
});
