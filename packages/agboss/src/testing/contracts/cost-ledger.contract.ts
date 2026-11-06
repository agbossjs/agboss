import { expect } from "vitest";
import { BudgetScope } from "../../budgets/budget.js";
import type {
  CostLedgerRepository,
  LedgerEntry,
} from "../../infrastructure/cost-ledger.repository.js";
import { usd } from "../../units/index.js";
import { applicationMonth, call, entry, tenantDay } from "./cost-ledger-data.js";
import { pruningCases } from "./cost-ledger-pruning.cases.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./instance-context.js";

const LEDGER_CASES: readonly ContractCase<CostLedgerRepository>[] = [
  {
    name: "each call's cost is added to every counter, shared by the instances",
    run: async ({ first, second }) => {
      await first.saveAll([tenantDay, applicationMonth], [call(0.25), call(0.5)]);
      await second.saveAll([tenantDay], [call(0.25)]);

      expect(await first.findSpentByCounter(tenantDay)).toBe(1);
      expect(await second.findSpentByCounter(applicationMonth)).toBe(0.75);
      expect(await second.findSpentByCounter({ ...tenantDay, key: "globex" })).toBe(0);
    },
  },
  {
    name: "a new period starts from zero; an execution's counter has no period",
    run: async ({ first, second }) => {
      const execution = { budget: "execution-budget", scope: BudgetScope.Execution, key: "run-1" };
      await first.saveAll([tenantDay, { ...execution, period: "" }], [call(0.75)]);

      expect(await second.findSpentByCounter({ ...tenantDay, period: "2026-10-19" })).toBe(0);
      expect(await second.findSpentByCounter({ ...execution, period: "" })).toBe(0.75);
    },
  },
  {
    name: "concurrent saves of two instances lose nothing",
    run: async ({ first, second }) => {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).saveAll([tenantDay], [call(0.125)]),
        ),
      );

      expect(await first.findSpentByCounter(tenantDay)).toBe(1.25);
    },
  },
  {
    // #634: every step's budget check reads every counter of the execution — none may lose a save
    name: "concurrent saves of two instances to several counters lose nothing in any of them",
    run: async ({ first, second }) => {
      const execution = { budget: "execution-budget", scope: BudgetScope.Execution, key: "run-1" };
      const counters = [tenantDay, applicationMonth, { ...execution, period: "" }];
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).saveAll(counters, [call(0.125), call(0.125)]),
        ),
      );

      for (const counter of counters) expect(await second.findSpentByCounter(counter)).toBe(2.5);
    },
  },
  {
    // #727: spend written as it is made carries its identity; a step run again saves it again
    name: "an entry with a ledgerId counts once: a repeated save on either instance adds nothing",
    run: async ({ first, second }) => {
      const once = entry("run-1:pay-action:1#0", 0.25);
      await first.saveAll([tenantDay, applicationMonth], [once, call(0.5)]);
      await second.saveAll([tenantDay, applicationMonth], [once, call(0.5)]);
      await first.saveAll([tenantDay], [once, once]);

      expect(await first.findSpentByCounter(tenantDay)).toBe(1.25);
      expect(await second.findSpentByCounter(applicationMonth)).toBe(1.25);
    },
  },
  {
    name: "a save with no counters adds nothing and keeps no entry: a later save of the id counts",
    run: async ({ first, second }) => {
      const unsaved = entry("run-1:pay-action:2#0", 0.25);
      await first.saveAll([], [unsaved, call(0.5)]);
      await second.saveAll([tenantDay], [unsaved]);

      expect(await first.findSpentByCounter(tenantDay)).toBe(0.25);
    },
  },
  {
    name: "concurrent saves count one entry once and lose none of the others",
    run: async ({ first, second }) => {
      const execution = { budget: "execution-budget", scope: BudgetScope.Execution, key: "run-1" };
      const counters = [tenantDay, { ...execution, period: "" }];
      const racing = (index: number): LedgerEntry =>
        entry(`run-1:pay-action:${String(index % 5)}#0`, 0.125);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? first : second).saveAll(counters, [racing(index)]),
        ),
      );

      // five entries, each saved four times by the two instances at once
      for (const counter of counters) expect(await first.findSpentByCounter(counter)).toBe(0.625);
    },
  },
  {
    // #817: a record without an identity could be counted on every retry — no store takes one
    name: "#817: what is no ledger entry is refused before anything is added — no id, an empty id, a madeAt that is no Date, a cost that is no amount",
    run: async ({ first, second }) => {
      const fine = entry("run-1:pass-f:0", 0.25);
      const withoutId: Partial<LedgerEntry> = { ...entry("run-1:pass-f:1", 0.5) };
      Reflect.deleteProperty(withoutId, "ledgerId");
      const broken: readonly unknown[] = [
        withoutId,
        { ...fine, ledgerId: "" },
        { ...fine, ledgerId: "run-1:pass-f:2", madeAt: "2026-10-18T12:00:00.000Z" },
        { ...fine, ledgerId: "run-1:pass-f:3", madeAt: Date.parse("2026-10-18T12:00:00.000Z") },
        { ...fine, ledgerId: "run-1:pass-f:4", madeAt: new Date(Number.NaN) },
        { ...fine, ledgerId: "run-1:pass-f:5", costUsd: Number.NaN },
        { ...fine, ledgerId: "run-1:pass-f:6", costUsd: -0.25 },
        null,
      ];
      for (const record of broken)
        await expect(
          // a JS caller (or a cast): what the type refuses, the store refuses at run time
          first.saveAll([tenantDay], [fine, record as LedgerEntry]),
        ).rejects.toMatchObject({ code: "cost-ledger.entry-invalid", index: 1 });

      expect(await second.findSpentByCounter(tenantDay)).toBe(0);
      // the refused saves kept nothing: the valid entry saved alone counts, once
      await second.saveAll([tenantDay], [fine]);
      expect(await first.findSpentByCounter(tenantDay)).toBe(0.25);
    },
  },
  {
    name: "keeps the last maxSpend() of an account: the last known limit",
    run: async ({ first, second }) => {
      const account = { budget: tenantDay.budget, scope: tenantDay.scope, key: tenantDay.key };

      expect(await first.findMaxSpendByAccount(account)).toBeUndefined();
      await first.saveMaxSpend(account, usd(40));
      await second.saveMaxSpend(account, usd(30));

      expect(await first.findMaxSpendByAccount(account)).toBe(30);
      expect(await first.findMaxSpendByAccount({ ...account, key: "globex" })).toBeUndefined();
    },
  },
];

/**
 * `CostLedgerRepository` (#265 AC8, #261 PR 5): one counter per budget, scope key and period, each
 * entry's cost added to every counter it is given, nothing lost between instances, an entry added
 * once by its `ledgerId` (#727), anything but a `LedgerEntry` refused (#817), the entries pruned
 * under a mark that refuses a later save of one pruned (#771); the last
 * `maxSpend()` per budget and scope key.
 */
export function costLedgerContract(target: ContractTarget<CostLedgerRepository>): void {
  registerContract(
    "cost ledger contract",
    target,
    [{ cases: LEDGER_CASES }, { cases: pruningCases() }],
    pingOf,
  );
}
