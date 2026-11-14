/**
 * #727, #732 on two instances — on the in-memory stores the test's instances share, and on one
 * SQLite file (each instance its own connection: only the file carries the spend). One step at a
 * time per instance: while item `a` pays $60 and works on one instance, item `b` runs on the other,
 * and its third $30 is held back at $120 — the ledger holds `a`'s spend from the moment it was made.
 * A child on any instance launched right after its parent paid $90 is queued only once that $90 is
 * in the ledger, wherever it runs. Every counter ends at what was paid.
 */
import { afterEach, describe, expect } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { TestConcurrency, testWith, type TestApp } from "../../src/testing/index.js";
import { readyAll } from "../app/fixtures/child-end-freeze.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import { execute } from "../helpers/flow.js";
import { sqliteFilePerTest } from "../infrastructure/sqlite/fixtures/sqlite.workflow.js";
import { SqliteSpendInFlightApplication } from "../infrastructure/sqlite/fixtures/spend-in-flight.application.js";
import {
  AnyPayItemsWorkflowStart,
  inFlight,
  ParentPayWorkflowStart,
  resetInFlight,
  SpendInFlightInstancesApplication,
} from "./fixtures/spend-in-flight.workflow.js";

sqliteFilePerTest();

let release = (): void => undefined;

afterEach(() => {
  release();
});

const STORES = [
  {
    stores: "the in-memory stores",
    application: "spend-in-flight-instances-application",
    two: testWith(SpendInFlightInstancesApplication, {
      instances: 2,
      concurrency: TestConcurrency.Real,
    }),
  },
  {
    stores: "one SQLite file",
    application: "sqlite-spend-in-flight-application",
    two: testWith(SqliteSpendInFlightApplication, {
      instances: 2,
      concurrency: TestConcurrency.Real,
    }),
  },
];

type Outcome = { readonly error: unknown } | { readonly done: true };
const outcomeOf = (run: Promise<unknown>): Promise<Outcome> =>
  run.then(
    () => ({ done: true }) as const,
    (error: unknown) => ({ error }),
  );

/** What every counter of the execution's budgets holds, in cents. */
async function countersOf(
  app: TestApp,
  application: string,
  executionId: string,
  now: Date,
): Promise<number[]> {
  const ledger = app.resolve(CostLedgerRepository);
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
      key: application,
      maxSpend: 0,
    },
  ];
  const values: number[] = [];
  for (const record of records)
    values.push(Math.round((await ledger.findSpentByCounter(counterOf(record, now))) * 100));
  return values;
}

const executionIdOf = (outcome: Outcome): string =>
  /execution (\S+) spent/u.exec("error" in outcome ? String(outcome.error) : "")?.[1] ?? "";

describe.each(STORES)("#727, #732 on two instances, on $stores", ({ application, two }) => {
  two("#727: b's pay-three on the other instance is held back at $120", async ({ apps, clock }) => {
    ({ release } = resetInFlight());
    await readyAll(apps);
    const app = instance(apps, 0);
    const run = outcomeOf(
      execute(app, AnyPayItemsWorkflowStart, [
        { name: "a", delay: 0, outcome: "ok" },
        { name: "b", delay: 0, outcome: "ok" },
      ]),
    );
    for (let i = 0; i < 40 && !inFlight.ran.includes("b:pay-two"); i += 1)
      await clock.advance("1s");
    for (let i = 0; i < 10; i += 1) await clock.advance("1s");

    // a works on one instance, b ran on the other
    expect(inFlight.where.get("b:pay-one")).toBeDefined();
    expect(inFlight.where.get("b:pay-one")).not.toBe(inFlight.where.get("a:pay-one"));
    expect(inFlight.ran.filter((step) => step.startsWith("b:"))).toEqual([
      "b:pay-one",
      "b:pay-two",
    ]);
    release();
    const outcome = await run;
    expect("error" in outcome ? outcome.error : outcome).toMatchObject({
      name: "BudgetExceededError",
      message: expect.stringContaining("spent $120;"),
    });
    expect(inFlight.ran).not.toContain("b:pay-three");
    expect(await countersOf(app, application, executionIdOf(outcome), clock.now())).toEqual([
      12000, 12000, 12000,
    ]);
  });

  two(
    "#732: the child is queued once the parent's $90 is in the ledger",
    async ({ apps, clock }) => {
      ({ release } = resetInFlight());
      await readyAll(apps);
      const app = instance(apps, 0);
      const run = outcomeOf(
        execute(app, ParentPayWorkflowStart, { name: "a", delay: 0, outcome: "ok" }),
      );
      // held below the store calls' bound (#928): a held write kept longer is given up on, its tree handed over
      for (let i = 0; i < 12; i += 1) await clock.advance("1s");

      expect(inFlight.ran).toEqual(["a:parent-pay"]);
      release();
      const outcome = await run;
      expect("error" in outcome ? outcome.error : outcome).toMatchObject({
        name: "BudgetExceededError",
        message: expect.stringContaining("spent $120;"),
      });
      expect(inFlight.ran).toEqual(["a:parent-pay", "a:child-one"]);
      // the child ran on the other instance
      expect(inFlight.where.get("a:child-one")).not.toBe(inFlight.where.get("a:parent-pay"));
      expect(await countersOf(app, application, executionIdOf(outcome), clock.now())).toEqual([
        12000, 12000, 12000,
      ]);
    },
  );
});
