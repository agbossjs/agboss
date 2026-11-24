/**
 * #1318a — what a budget limits and how it says so: `maxSpend` / `maxTokens` in `@Budget`, a
 * `defineEnv` value, or `limit()`; one of them, never both, never none; an amount that is no count is
 * refused before the first step.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { budgetRuleViolations } from "../../src/budgets/budget-rules.js";
import { env } from "../../src/environments/index.js";
import type { Class } from "../../src/components/injection.js";
import { DEFAULT_CONTEXT_VALUES } from "../../src/flow/context/context-values.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { openExecutionBudgets } from "../../src/run/run-budgets.js";
import type { AgentExecutionDeps } from "../../src/run/types.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { fakeDeps } from "../helpers.js";
import { usd, type Usd } from "../../src/units/index.js";

const clock = new VirtualClock();

const opened = async (budget: Class, ledger = new InMemoryCostLedgerRepository()) => {
  const base = await fakeDeps({}, {});
  const deps: AgentExecutionDeps<string> = {
    ...base,
    budgets: {
      budgets: [budget],
      applicationName: "shop",
      resolve: (cls: Class) => new (cls as new () => object)(),
      ledger,
      clock,
    },
  };
  return openExecutionBudgets(deps, {
    executionId: "execution-1",
    threadId: "thread-1",
    start: "chat-workflow-start",
    contexts: DEFAULT_CONTEXT_VALUES,
  });
};

@Budget({ name: "declared-budget", scope: BudgetScope.Execution, maxSpend: usd(2), maxTokens: 500 })
class Declared {}

@Budget({ name: "tokens-budget", scope: BudgetScope.Execution })
class Coded {
  limit(): { maxTokens: number } {
    return { maxTokens: 7 };
  }
}

@Budget({ name: "usd-budget", scope: BudgetScope.Execution })
class LegacyUsd {
  maxSpend(): Usd {
    return usd(3);
  }
}

@Budget({ name: "empty-limit-budget", scope: BudgetScope.Execution })
class GivesNothing {
  limit(): Record<string, never> {
    return {};
  }
}

@Budget({ name: "fraction-budget", scope: BudgetScope.Execution })
class FractionalTokens {
  limit(): { maxTokens: number } {
    return { maxTokens: 1.5 };
  }
}

@Budget({ name: "nan-budget", scope: BudgetScope.Execution })
class NanSpend {
  limit(): { maxSpend: Usd } {
    return { maxSpend: Number.NaN as Usd };
  }
}

describe("#1318a: the limits an execution opens with", () => {
  it("reads declared limits, a limit() and a maxSpend() into the record and the ledger", async () => {
    const ledger = new InMemoryCostLedgerRepository();

    const declared = await opened(Declared, ledger);
    const coded = await opened(Coded);
    const legacy = await opened(LegacyUsd);

    expect(declared.records[0]).toMatchObject({ maxSpend: 2, maxTokens: 500 });
    expect(coded.records[0]).toMatchObject({ maxTokens: 7 });
    expect(coded.records[0]).not.toHaveProperty("maxSpend");
    expect(legacy.records[0]).toMatchObject({ maxSpend: 3 });
    expect(
      await ledger.findLimitByAccount({
        budget: "declared-budget",
        scope: BudgetScope.Execution,
        key: "execution-1",
      }),
    ).toEqual({ maxSpend: 2, maxTokens: 500 });
  });

  it("reads an env value when the execution starts", async () => {
    process.env.TEST_TOKEN_CAP_1318 = "321";

    @Budget({
      name: "env-budget",
      scope: BudgetScope.Execution,
      maxTokens: env.integer("TEST_TOKEN_CAP_1318"),
    })
    class FromEnv {}

    expect((await opened(FromEnv)).records[0]).toMatchObject({ maxTokens: 321 });
    delete process.env.TEST_TOKEN_CAP_1318;
  });

  it.each([
    ["no limit at all", GivesNothing],
    ["a fractional token cap", FractionalTokens],
    ["a NaN dollar cap", NanSpend],
  ])("refuses %s before the first step, naming the budget and no value", async (_, budget) => {
    const refused = await opened(budget).catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(Error);
    expect(String(refused)).toContain("budget");
  });
});

describe("#1318a: [budget.missing-limit] and [budget.conflicting-limit]", () => {
  @Budget({ name: "none-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
  class Missing {}

  @Budget({
    name: "both-ways-budget",
    scope: BudgetScope.Tenant,
    period: BudgetPeriod.Day,
    maxTokens: 5,
  })
  class Conflicting {
    limit(): { maxTokens: number } {
      return { maxTokens: 5 };
    }
  }

  const codesOf = (budgets: readonly Class[]): string[] =>
    budgetRuleViolations({ name: "shop", workflows: [], budgets }).map(({ code }) => code);

  it("a budget that limits nothing, or limits twice, is a violation", () => {
    expect(codesOf([Missing])).toContain("budget.missing-limit");
    expect(codesOf([Conflicting])).toContain("budget.conflicting-limit");
  });

  it("one that declares, or has limit(), or has maxSpend(), is none", () => {
    for (const budget of [Declared, Coded, LegacyUsd]) {
      const codes = codesOf([budget]);
      expect(codes).not.toContain("budget.missing-limit");
      expect(codes).not.toContain("budget.conflicting-limit");
    }
  });

  it("a tenant budget is required only when the application has a tenantContext", () => {
    const without = budgetRuleViolations({ name: "shop", workflows: [], budgets: [] });
    const withTenants = budgetRuleViolations({
      name: "shop",
      workflows: [],
      budgets: [],
      tenantContext: Object,
    });

    expect(without.map(({ code }) => code)).not.toContain("budget.tenant-budget-required");
    expect(withTenants.map(({ code }) => code)).toContain("budget.tenant-budget-required");
  });
});
