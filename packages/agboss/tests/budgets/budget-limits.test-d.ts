import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expectTypeOf, it } from "vitest";
import { Budget, BudgetScope, BudgetUnit, type BudgetHandler } from "../../src/budgets/budget.js";
import {
  type BudgetLimit,
  type BudgetUsage,
  type CostLedgerRepository,
} from "../../src/infrastructure/cost-ledger.repository.js";
import type { Usd } from "../../src/units/index.js";

describe("#1318a: budgets limit dollars and tokens", () => {
  it("the ledger answers usage and limits", () => {
    expectTypeOf<CostLedgerRepository["findUsageByCounter"]>().returns.toEqualTypeOf<
      Promise<BudgetUsage>
    >();
    expectTypeOf<BudgetUsage>().toEqualTypeOf<{ readonly spent: Usd; readonly tokens: number }>();
    expectTypeOf<CostLedgerRepository["findLimitByAccount"]>().returns.toEqualTypeOf<
      Promise<BudgetLimit | undefined>
    >();
    expectTypeOf<CostLedgerRepository["saveLimit"]>().parameter(1).toEqualTypeOf<BudgetLimit>();
    expectTypeOf<BudgetLimit>().toEqualTypeOf<{
      readonly maxSpend?: Usd | undefined;
      readonly maxTokens?: number | undefined;
    }>();
  });

  it("the old ledger methods are gone", () => {
    expectTypeOf<CostLedgerRepository>().not.toHaveProperty("findSpentByCounter");
    expectTypeOf<CostLedgerRepository>().not.toHaveProperty("findMaxSpendByAccount");
    expectTypeOf<CostLedgerRepository>().not.toHaveProperty("saveMaxSpend");
  });

  it("a breach names its unit and both caps", () => {
    expectTypeOf<LimitError.Budget["unit"]>().toEqualTypeOf<BudgetUnit>();
    expectTypeOf<LimitError.Budget["maxSpend"]>().toEqualTypeOf<Usd | undefined>();
    expectTypeOf<LimitError.Budget["maxTokens"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LimitError.Budget["usedTokens"]>().toEqualTypeOf<number>();
  });

  it("a budget handler may have limit() returning a BudgetLimit", () => {
    expectTypeOf<NonNullable<BudgetHandler["limit"]>>().returns.toEqualTypeOf<
      BudgetLimit | Promise<BudgetLimit>
    >();
  });

  it("@Budget takes maxSpend and maxTokens, and a class needs no handler", () => {
    @Budget({ name: "tokens-budget", scope: BudgetScope.Execution, maxTokens: 10 })
    class Tokens {}
    expectTypeOf<typeof Tokens>().toBeConstructibleWith();
  });

  it("a token cap is a number, never text", () => {
    // @ts-expect-error -- maxTokens is a number
    Budget({ name: "bad-budget", scope: BudgetScope.Execution, maxTokens: "10" });
    expectTypeOf<BudgetUnit>().toEqualTypeOf<BudgetUnit>();
  });
});
