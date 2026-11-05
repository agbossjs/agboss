import { expect } from "vitest";
import { BudgetScope } from "../../budgets/budget.js";
import type { UsageRecord } from "../../finops/usage.js";
import type { CostLedgerRepository } from "../../infrastructure/cost-ledger.repository.js";
import { applicationMonth, call, tenantDay } from "./cost-ledger-data.js";
import type { ContractCase } from "./define.js";

/**
 * The cost ledger contract's pruning (#771): entries dated by `madeAt`, removed under a mark that
 * never goes back, and a save of one the store may have pruned refused — never counted twice.
 */

/** A record with a `ledgerId` (#727) made at `madeAt` (#771). */
type EntryRecord = UsageRecord & { readonly ledgerId: string };

const entry = (ledgerId: string, costUsd: number, madeAt: string): EntryRecord => ({
  ...call(costUsd),
  ledgerId,
  madeAt,
});

/** What a refused save rejects with (#771): its expired entries and the store's mark. */
const expired = (ledgerIds: readonly string[], prunedBefore: string) => ({
  code: "cost-ledger.entry-expired",
  ledgerIds,
  prunedBefore: new Date(prunedBefore),
});

const PRUNING_CASES: readonly ContractCase<CostLedgerRepository>[] = [
  {
    // #771: entries are pruned; one the store may have pruned is never counted again
    name: "#771: a prune removes the entries made before its cutoff, never a counter: a later save of one is refused and adds nothing",
    run: async ({ first, second }) => {
      const old = entry("run-1:pass-a:0", 0.25, "2026-10-18T08:00:00.000Z");
      const young = entry("run-1:pass-a:1", 0.5, "2026-10-18T10:00:00.000Z");
      const atCutoff = entry("run-1:pass-a:2", 0.125, "2026-10-18T09:00:00.000Z");
      await first.saveAll([tenantDay, applicationMonth], [old, young, atCutoff]);
      await second.deleteEntriesByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));

      expect(await first.findSpentByCounter(tenantDay)).toBe(0.875);
      await expect(first.saveAll([tenantDay], [old, call(0.125)])).rejects.toMatchObject(
        expired([old.ledgerId], "2026-10-18T09:00:00.000Z"),
      );
      await expect(second.saveAll([tenantDay], [old])).rejects.toMatchObject(
        expired([old.ledgerId], "2026-10-18T09:00:00.000Z"),
      );
      // one made at or after the cutoff is held: saved again, it adds nothing
      await second.saveAll([tenantDay, applicationMonth], [young, atCutoff]);

      expect(await second.findSpentByCounter(tenantDay)).toBe(0.875);
      expect(await first.findSpentByCounter(applicationMonth)).toBe(0.875);
    },
  },
  {
    name: "#771: a write retried after its answer was lost counts once before a prune, and is refused after it — with the whole save",
    run: async ({ first, second }) => {
      const lost = entry("run-1:pass-b:0", 0.25, "2026-10-18T08:00:00.000Z");
      // it landed, the caller heard an error: the retry finds it held
      await first.saveAll([tenantDay], [lost]);
      await first.saveAll([tenantDay], [lost]);
      expect(await first.findSpentByCounter(tenantDay)).toBe(0.25);

      await second.deleteEntriesByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));
      const fresh = entry("run-1:pass-b:1", 0.5, "2026-10-18T10:00:00.000Z");
      await expect(first.saveAll([tenantDay], [fresh, lost, call(0.125)])).rejects.toMatchObject(
        expired([lost.ledgerId], "2026-10-18T09:00:00.000Z"),
      );

      expect(await second.findSpentByCounter(tenantDay)).toBe(0.25);
      // the fresh one was not kept by the refused save: saved alone, it counts
      await second.saveAll([tenantDay], [fresh]);
      expect(await first.findSpentByCounter(tenantDay)).toBe(0.75);
    },
  },
  {
    name: "#771: the pruning mark never goes back: an earlier cutoff after a later one still refuses what the later may have removed",
    run: async ({ first, second }) => {
      const between = entry("run-1:pass-c:0", 0.25, "2026-10-18T09:30:00.000Z");
      await first.deleteEntriesByMadeAtBefore(new Date("2026-10-18T10:00:00.000Z"));
      await second.deleteEntriesByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));

      await expect(first.saveAll([tenantDay], [between])).rejects.toMatchObject(
        expired([between.ledgerId], "2026-10-18T10:00:00.000Z"),
      );
      // an entry without a date is the oldest: refused once anything was pruned
      const undated: UsageRecord = { ...call(0.25), ledgerId: "run-1:pass-c:2" };
      await expect(second.saveAll([tenantDay], [undated])).rejects.toMatchObject(
        expired(["run-1:pass-c:2"], "2026-10-18T10:00:00.000Z"),
      );
      const after = entry("run-1:pass-c:1", 0.5, "2026-10-18T10:00:00.000Z");
      // a call without a ledgerId is no entry: never refused
      await second.saveAll([tenantDay], [after, after, call(0.125)]);
      await first.saveAll([tenantDay], [after]);

      expect(await second.findSpentByCounter(tenantDay)).toBe(0.625);
    },
  },
  {
    name: "#771: saves racing a prune on the other instance count each entry at most once, and only what they resolved",
    run: async ({ first, second }) => {
      const execution = { budget: "execution-budget", scope: BudgetScope.Execution, key: "run-1" };
      const counters = [tenantDay, { ...execution, period: "" }];
      const racing = (index: number): EntryRecord =>
        entry(`run-1:pass-d:${String(index % 10)}`, 0.125, "2026-10-18T08:00:00.000Z");
      const save = (index: number) =>
        (index % 2 === 0 ? first : second).saveAll(counters, [racing(index)]);
      const before = Array.from({ length: 10 }, (_, index) => save(index));
      const prune = second.deleteEntriesByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z"));
      const after = Array.from({ length: 10 }, (_, index) => save(index + 10));
      const outcomes = await Promise.allSettled([...before, ...after]);
      await prune;
      const resolved = new Set<string>();
      outcomes.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") resolved.add(racing(index).ledgerId);
        else expect(outcome.reason).toMatchObject({ code: "cost-ledger.entry-expired" });
      });

      // every entry a save resolved counts once; none refused counts
      const counted = 0.125 * resolved.size;
      for (const counter of counters) expect(await first.findSpentByCounter(counter)).toBe(counted);
      // saved again on both, after the prune: refused or held — nothing more
      for (let index = 0; index < 20; index += 1)
        await save(index).catch((error: unknown) => {
          expect(error).toMatchObject({ code: "cost-ledger.entry-expired" });
        });
      for (const counter of counters)
        expect(await second.findSpentByCounter(counter)).toBe(counted);
    },
  },
];

/** The pruning cases of the cost ledger contract (#771). */
export const pruningCases = (): readonly ContractCase<CostLedgerRepository>[] => PRUNING_CASES;
