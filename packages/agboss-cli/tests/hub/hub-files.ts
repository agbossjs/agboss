/**
 * The files `agboss hub` reads in its tests (#401 PR 3), written as the commands that make them
 * write them: two applications' `describe --json` envelopes (the shop that calls the billing desk
 * over A2A, #398), their kept executions exported as `agboss records export` does — the call seen
 * from both sides, a budget failure — and an eval run artifact of the shop.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { ExecutionHistoryStatus, ToolCallStatus, type ExecutionHistoryRecord } from "agboss";
import type { EvalRunReport } from "agboss/eval";
import { exportedRecordLine } from "agboss/internal";
import {
  historyRecordOf,
  toolCallOf,
} from "../../../agboss/tests/eval/fixtures/history-records.js";
import { agboss, fixture } from "../cli/agboss.js";
import { REFUNDS_ARTIFACT } from "../eval-html/artifacts.js";

export const SHOP = "shop-kb-application";
export const BILLING = "billing-application";

const SHOP_APPLICATION = fixture("../federation/fixtures/shop.application.ts");
const BILLING_APPLICATION = fixture("../federation/fixtures/compatible-billing.workflow.ts");

/** The key of the shop's call to the billing desk: the same on both sides. */
const CALL_KEY = "s1:quote-agent:1:call-ask-billing-tool";

const shopCall = (): ExecutionHistoryRecord => {
  const call = toolCallOf("ask-billing-tool", { question: "<email> refund?" });
  return historyRecordOf("s1", {
    application: { name: SHOP, version: "1.0.0", instanceId: "i-shop" },
    workflow: {
      name: "quote-workflow",
      version: "1.0.0",
      startedVersion: "1.0.0",
      configHash: "q",
    },
    toolCalls: [
      {
        ...call,
        step: { ...call.step, idempotencyKey: CALL_KEY },
        remote: { application: BILLING, executionId: "b1" },
      },
    ],
  });
};

const shopBudgetFailure = (): ExecutionHistoryRecord =>
  historyRecordOf("s2", {
    application: { name: SHOP, version: "1.0.0", instanceId: "i-shop" },
    status: ExecutionHistoryStatus.Failed,
    startedAt: "2026-01-06T09:00:00.000Z",
    endedAt: "2026-01-06T09:00:30.000Z",
    error: {
      name: "StepFailedError",
      code: "step.failed",
      lineage: ["step.failed", "step"],
      message: "the step failed",
      cause: {
        name: "BudgetExceededError",
        code: "limit.budget",
        lineage: ["limit.budget", "limit"],
        message: "spent",
      },
    },
    toolCalls: [toolCallOf("ask-billing-tool", {}, ToolCallStatus.Declined)],
  });

const billingReceived = (): ExecutionHistoryRecord =>
  historyRecordOf("b1", {
    application: { name: BILLING, version: "1.0.0", instanceId: "i-billing" },
    workflow: {
      name: "billing-workflow",
      version: "1.0.0",
      startedVersion: "1.0.0",
      configHash: "b",
    },
    origin: {
      application: SHOP,
      hops: 1,
      rootExecutionId: "s1",
      executionId: "s1",
      workflow: { name: "quote-workflow", version: "1.0.0" },
      step: { component: "quote-agent", idempotencyKey: CALL_KEY },
    },
  });

/** The shop's eval run: its suite's latest. */
const shopRun = (): EvalRunReport => ({
  ...REFUNDS_ARTIFACT,
  application: { name: SHOP, version: "1.0.0" },
  workflow: { name: "quote-workflow", version: "1.0.0" },
});

const lines = (records: readonly ExecutionHistoryRecord[]): string =>
  `${records.map(exportedRecordLine).join("\n")}\n`;

/** A folder `hub/` with every kind of input, in the layout the issue's example uses. */
export async function hubFolder(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "agboss-hub-"));
  for (const [name, application] of [
    ["shop", SHOP_APPLICATION],
    ["billing", BILLING_APPLICATION],
  ] as const) {
    const described = await agboss(["describe", "--application", application, "--json"], cwd);
    expect(described.code).toBe(0);
    mkdirSync(join(cwd, "hub", name, "records"), { recursive: true });
    writeFileSync(join(cwd, "hub", name, "describe.json"), described.stdout);
  }
  writeFileSync(
    join(cwd, "hub", "shop", "records", "week.jsonl"),
    lines([shopCall(), shopBudgetFailure()]),
  );
  writeFileSync(join(cwd, "hub", "billing", "records", "week.jsonl"), lines([billingReceived()]));
  writeFileSync(join(cwd, "hub", "shop", "refunds.run.json"), JSON.stringify(shopRun()));
  return cwd;
}
