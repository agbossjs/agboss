/**
 * #727 — a step run again after its worker froze bills again, and counts again. A child on any
 * instance pays $60 and works on in the same step; its worker freezes there (its lease stalls), the
 * other instance reclaims the child and runs the step again from the child's last checkpoint — the
 * service is paid $60 again. That is new spend, under a new ledger identity (each pass's own): the
 * ledger holds $120 and the child's next step is held back at it (the execution may spend $100).
 * An identity derived from where the spend was made would take the second $60 for the first's
 * replay and let the tree go on at $60.
 */
import { afterEach, describe, expect } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { TestConcurrency, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { readyAll } from "../app/fixtures/child-end-freeze.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import {
  AnyPayItemsWorkflowStart,
  inFlight,
  resetInFlight,
  SpendInFlightInstancesApplication,
} from "./fixtures/spend-in-flight.workflow.js";

const test = testWith(SpendInFlightInstancesApplication, {
  instances: 2,
  concurrency: TestConcurrency.Real,
});

let release = (): void => undefined;

afterEach(() => {
  release();
});

const ranPayOne = (): number => inFlight.ran.filter((step) => step === "a:pay-one").length;

describe("#727: a step run again after a takeover bills again and counts again", () => {
  test("the reclaimed child pays $60 again: every counter holds both, the next step held back", async ({
    apps,
    clock,
    leases,
  }) => {
    ({ release } = resetInFlight());
    const byName = await readyAll(apps);
    const app = instance(apps, 0);
    const call = execute(app, AnyPayItemsWorkflowStart, [{ name: "a", delay: 0, outcome: "ok" }]);
    await until(() => ranPayOne() === 1, "a paid on its worker");
    const worker = byName.get(inFlight.where.get("a:pay-one") ?? "");
    if (worker === undefined) throw new Error("no worker ran a");
    leases.stall(worker);
    for (let step = 0; step < 12 && ranPayOne() < 2; step += 1) await clock.advance(seconds(10));
    await until(() => ranPayOne() === 2, "the other instance runs a's step again");
    release();
    const outcome = await call.then(
      () => undefined,
      (error: unknown) => error,
    );
    leases.resume(worker);

    // the step's $60 was paid twice — once per run — and both count: a's next step is held back
    expect(outcome).toMatchObject({
      name: "BudgetExceededError",
      message: expect.stringContaining("spent $120;"),
    });
    const executionId = /execution (\S+) spent/u.exec(String(outcome))?.[1] ?? "";
    const ledger = app.resolve(CostLedgerRepository);
    const now = clock.now();
    const records: readonly ExecutionBudgetRecord[] = [
      {
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: executionId,
        maxSpend: 0,
      },
      {
        budget: { name: "test-tenant-daily-budget" },
        scope: BudgetScope.Tenant,
        period: BudgetPeriod.Day,
        key: "default",
        maxSpend: 0,
      },
      {
        budget: { name: "test-application-daily-budget" },
        scope: BudgetScope.Application,
        period: BudgetPeriod.Day,
        key: "spend-in-flight-instances-application",
        maxSpend: 0,
      },
    ];
    for (const record of records)
      expect(await ledger.findSpentByCounter(counterOf(record, now))).toBe(120);
  });
});
