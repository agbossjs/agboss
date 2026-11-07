/**
 * #685 — counted once after a takeover, on two instances sharing the in-memory stores. A tree runs
 * on one instance; its child on any instance runs on the other, pays, then holds; that worker
 * stalls, and the tree's instance reclaims the child once its lease ran out and continues it from
 * its last checkpoint — the hold again, never the payment. Every payment was made once, and the
 * ledger's counters hold each once: the new worker's meter starts from what the checkpoint says
 * was spent, which the ledger has already, and the parent takes the child's spend in once.
 */
import { afterEach, beforeEach, describe, expect } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf } from "../../src/budgets/execution-budgets.js";
import { testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { until } from "../helpers/until.js";
import { readyAll } from "../app/fixtures/child-end-freeze.js";
import { instance } from "../app/fixtures/fence-takeover.js";
import { resetSpendTree, spendTree, SpendTreeLedger } from "./fixtures/spend-tree.actions.js";
import { SpendTreeApplication, SpendTreeWorkflowStart } from "./fixtures/spend-tree.workflow.js";

const test = testWith(SpendTreeApplication, { instances: 2 });

let release: () => void = () => undefined;

beforeEach(() => {
  // the budget a cent above the plan: a dollar counted twice would stop the tree
  resetSpendTree(
    { cents: 700, local: [300], remote: [2000], afterCents: 100, closeCents: 0 },
    3101,
    2,
  );
  spendTree.held = new Promise((resolve) => {
    release = resolve;
  });
});

afterEach(() => {
  release();
});

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + value, 0);

const counters = [
  { name: "spend-tree-execution-budget", scope: BudgetScope.Execution },
  { name: "spend-tree-tenant-budget", scope: BudgetScope.Tenant, key: "default" },
  {
    name: "spend-tree-application-budget",
    scope: BudgetScope.Application,
    key: "spend-tree-application",
  },
] as const;

describe("#685: counted once after a takeover", () => {
  test("a child on any instance whose worker stalls while it holds, reclaimed: each payment once in every counter", async ({
    apps,
    clock,
    leases,
  }) => {
    const byName = await readyAll(apps);
    const a = instance(apps, 0);
    const call = execute(a, SpendTreeWorkflowStart, { path: "L1" });
    await until(() => spendTree.holds === 1, "the child held on its worker");
    const worker = byName.get(spendTree.holders[0] ?? "");
    if (worker === undefined || worker === a) throw new Error("the child runs beside its tree");
    leases.freeze(worker);
    for (let step = 0; step < 12 && spendTree.holds < 2; step += 1)
      await clock.advance(seconds(10));
    await until(() => spendTree.holds === 2, "the tree's instance reclaims the held child");
    release();
    const done = await call;
    leases.thaw(worker);

    // the payment before the hold ran once, on the stalled worker
    const paid = sum(spendTree.paid);
    expect(spendTree.paid).toEqual([700, 300, 1000, 1000, 100]);
    expect(Math.round(done.spend.totalUsd * 100)).toBe(paid);
    const ledger = a.resolve(SpendTreeLedger);
    const now = clock.now();
    const counted = await Promise.all(
      counters.map(async (each) => {
        const { name, scope } = each;
        const record =
          scope === BudgetScope.Execution
            ? { budget: { name }, scope, key: done.executionId, maxSpend: 0 }
            : { budget: { name }, scope, key: each.key, period: BudgetPeriod.Day, maxSpend: 0 };
        return Math.round((await ledger.findSpentByCounter(counterOf(record, now))) * 100);
      }),
    );
    expect(counted).toEqual([paid, paid, paid]);
  });
});
