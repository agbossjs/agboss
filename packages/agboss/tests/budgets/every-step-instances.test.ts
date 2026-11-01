/**
 * #634 — the budgets of another instance's spend, at an action: an order is held on one instance
 * (its execution has spent nothing) while another instance spends the tenant's and the
 * application's day; when the held order goes on, its next step — an action — is refused, from the
 * ledger the two instances share. On the in-memory stores (shared by the test's instances) and on
 * one SQLite file (each instance its own connection: only the file carries the spend).
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { BudgetExceededError, BudgetScope } from "../../src/index.js";
import { testWith, type TestApp } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { SqlitePaidStepsApplication } from "../infrastructure/sqlite/fixtures/sqlite-paid-steps.application.js";
import {
  PaidHoldWorkflowFinish,
  PaidHoldWorkflowStart,
} from "./fixtures/paid-launches.workflow.js";
import { PaidStepsApplication } from "./fixtures/paid-steps.application.js";
import { holdOrders, paidSteps, resetPaidSteps } from "./fixtures/paid-steps.dto.js";
import { PaidFinishWorkflowStart } from "./fixtures/paid-steps.workflow.js";

sqliteFilePerTest();

let release: () => void = () => undefined;

beforeEach(() => {
  resetPaidSteps();
  release = holdOrders();
});

afterEach(() => {
  release();
});

/** Holds an order on the first instance, spends `charge` on the second, then lets the order go. */
async function holdThenSpend(apps: readonly TestApp[], charge: number): Promise<unknown> {
  const held = execute(instance(apps, 0), PaidHoldWorkflowStart, { orderId: "held" });
  held.catch(() => undefined);
  await until(() => paidSteps.ran.includes("hold"), "the order held on the first instance");
  paidSteps.charge = charge;
  await execute(instance(apps, 1), PaidFinishWorkflowStart, { orderId: "spender" });
  release();
  return held;
}

const STORES = [
  { stores: "the in-memory stores", two: testWith(PaidStepsApplication, { instances: 2 }) },
  { stores: "one SQLite file", two: testWith(SqlitePaidStepsApplication, { instances: 2 }) },
];

describe.each(STORES)(
  "#634: another instance's spend holds an action back, on $stores",
  ({ two }) => {
    two(
      "the day spent on the other instance: the held order's action is refused",
      async ({ apps }) => {
        const held = holdThenSpend(apps, 1000);

        await expect(held).rejects.toBeInstanceOf(BudgetExceededError);
        // the held execution spent nothing of its own: the refusal is the day's, read from the ledger
        await expect(held).rejects.toMatchObject({
          budget: { name: "test-application-daily-budget" },
          scope: BudgetScope.Application,
          maxSpend: 1000,
          spent: 1000,
        });
        expect(paidSteps.ran).toEqual(["hold", "charge"]);
      },
    );

    two("with the day not spent the held order goes on", async ({ apps }) => {
      const done = await holdThenSpend(apps, 999);

      expect(done).toFinishWith(PaidHoldWorkflowFinish, { note: "note" });
      expect(paidSteps.ran).toEqual(["hold", "charge", "note"]);
    });
  },
);
