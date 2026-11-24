import { expect } from "vitest";
import type {
  CostLedgerRepository,
  LedgerEntry,
} from "../../infrastructure/cost-ledger.repository.js";
import { usd } from "../../units/index.js";
import { applicationMonth, entry, tenantDay, tokenCall } from "./cost-ledger-data.js";
import type { ContractCase } from "./define.js";

/**
 * The cost ledger contract's tokens (#1318): a counter holds the tokens of its entries beside their
 * dollars — a `$0` call with tokens counts — once by the entry's `ledgerId`, a prune never lowers
 * them, a limit is a dollar cap, a token cap or both, and a count that is no count is refused.
 */

const TOKEN_CASES: readonly ContractCase<CostLedgerRepository>[] = [
  {
    name: "adds the tokens of a call beside its dollars, and of a $0 call alone (#1318)",
    run: async ({ first, second }) => {
      await first.saveAll([tenantDay], [tokenCall(40, 0.25), tokenCall(8)]);
      await second.saveAll([tenantDay, applicationMonth], [tokenCall(100)]);

      expect(await first.findUsageByCounter(tenantDay)).toEqual({ spent: 0.25, tokens: 148 });
      expect(await second.findUsageByCounter(applicationMonth)).toEqual({ spent: 0, tokens: 100 });
      expect(await second.findUsageByCounter({ ...tenantDay, key: "globex" })).toEqual({
        spent: 0,
        tokens: 0,
      });
    },
  },
  {
    name: "counts the tokens of an entry once by its ledgerId (#1318)",
    run: async ({ first, second }) => {
      const repeated = tokenCall(60);

      await Promise.all([
        first.saveAll([tenantDay], [repeated]),
        second.saveAll([tenantDay], [repeated]),
      ]);
      await first.saveAll([tenantDay], [repeated]);

      expect((await first.findUsageByCounter(tenantDay)).tokens).toBe(60);
    },
  },
  {
    name: "adds the tokens of concurrent saves without losing one (#1318)",
    run: async ({ first, second }) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          (index % 2 === 0 ? first : second).saveAll([tenantDay], [tokenCall(10)]),
        ),
      );

      expect((await second.findUsageByCounter(tenantDay)).tokens).toBe(200);
    },
  },
  {
    name: "keeps a token-only or a USD-only limit of an account, never one as the other (#1318)",
    run: async ({ first, second }) => {
      const account = { budget: tenantDay.budget, scope: tenantDay.scope, key: tenantDay.key };

      await first.saveLimit(account, { maxTokens: 1000 });
      expect(await second.findLimitByAccount(account)).toEqual({ maxTokens: 1000 });
      await second.saveLimit(account, { maxSpend: usd(5) });
      expect(await first.findLimitByAccount(account)).toEqual({ maxSpend: 5 });
      await first.saveLimit(account, { maxSpend: usd(5), maxTokens: 7 });
      expect(await second.findLimitByAccount(account)).toEqual({ maxSpend: 5, maxTokens: 7 });
    },
  },
  {
    name: "refuses an entry whose tokens are no count, adding nothing (#1318)",
    run: async ({ first }) => {
      const broken = { ...tokenCall(10), outputTokens: Number.NaN } as LedgerEntry;

      await expect(first.saveAll([tenantDay], [broken])).rejects.toMatchObject({
        code: "cost-ledger.entry-invalid",
      });
      expect((await first.findUsageByCounter(tenantDay)).tokens).toBe(0);
    },
  },
  {
    // #1318: the counter folds the tokens of a pruned entry as it folds its dollars
    name: "#1318: a prune keeps the tokens of the entries it removes: pruning cannot reset a token budget, and a spend racing the prune is counted once",
    run: async ({ first, second }) => {
      const tokensOf = (id: string, at: string, tokens: number): LedgerEntry => ({
        ...entry(id, 0, at),
        inputTokens: tokens,
        costUsd: usd(0),
      });
      const old = tokensOf("run-2:pass-a:0", "2026-10-18T08:00:00.000Z", 70);
      const young = tokensOf("run-2:pass-a:1", "2026-10-18T10:00:00.000Z", 30);
      await first.saveAll([tenantDay], [old]);

      const racing = [
        second.deleteByMadeAtBefore(new Date("2026-10-18T09:00:00.000Z")),
        first.saveAll([tenantDay], [young]),
      ];
      await Promise.all(racing);

      expect((await first.findUsageByCounter(tenantDay)).tokens).toBe(100);
      await expect(second.saveAll([tenantDay], [old])).rejects.toMatchObject({
        code: "cost-ledger.entry-expired",
      });
      expect((await second.findUsageByCounter(tenantDay)).tokens).toBe(100);
    },
  },
];

/** The token cases of the cost ledger contract (#1318). */
export const tokenCases = (): readonly ContractCase<CostLedgerRepository>[] => TOKEN_CASES;
