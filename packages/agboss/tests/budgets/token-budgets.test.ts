/**
 * #1318a — token budgets and the shared `@Budget`: dollars and tokens are both enforced and each
 * fails closed; a `$0` call with tokens is spend; a budget's counter is the budget's, never a
 * workflow's; pruning the ledger cannot reset a token counter.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetPeriod, BudgetScope, BudgetUnit } from "../../src/budgets/budget.js";
import {
  budgetsOfExecution,
  counterOf,
  type ApplicationBudgets,
  type ExecutionBudgetRecord,
} from "../../src/budgets/budget-check.js";
import { budgetRuleViolations } from "../../src/budgets/budget-rules.js";
import type { Class } from "../../src/components/injection.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { CostSource, type UsageRecord } from "../../src/finops/usage.js";
import {
  InMemoryCostLedgerRepository,
  type LedgerEntry,
} from "../../src/infrastructure/cost-ledger.repository.js";
import {
  continuedExecutionBudgets,
  openExecutionBudgets,
  recorder,
} from "../../src/run/run-budgets.js";
import type { AgentExecutionDeps } from "../../src/run/types.js";
import { DEFAULT_CONTEXT_VALUES } from "../../src/flow/context/context-values.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { BudgetExceededError } from "../../src/errors.js";
import { usd } from "../../src/units/index.js";
import { fakeDeps } from "../helpers.js";

const clock = new VirtualClock();

/** A call of `tokens` tokens that cost `cost` — `0` is an unpriced CLI or local model. */
const call = (tokens: number, cost = 0, caller = "cli-agent"): UsageRecord => ({
  caller,
  model: "local/m",
  inputTokens: tokens - Math.floor(tokens / 4),
  outputTokens: Math.floor(tokens / 4),
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(cost),
  costSource: cost === 0 ? CostSource.Unpriced : CostSource.Api,
});

const tokenBudget = (maxTokens: number, key = "execution-1"): ExecutionBudgetRecord => ({
  budget: { name: "token-budget" },
  scope: BudgetScope.Execution,
  key,
  maxTokens,
});

const bothBudget = (maxSpend: number, maxTokens: number): ExecutionBudgetRecord => ({
  budget: { name: "both-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend,
  maxTokens,
});

const deps = async (
  ledger: InMemoryCostLedgerRepository,
  budgets: readonly Class[] = [],
  workflow?: Class,
): Promise<AgentExecutionDeps<string>> => {
  const base = await fakeDeps({}, {});
  return {
    ...base,
    graph: workflow === undefined ? base.graph : { ...base.graph, type: workflow },
    budgets: {
      budgets,
      applicationName: "shop",
      resolve: (cls: Class) => new (cls as new () => object)(),
      ledger,
      clock,
    } satisfies ApplicationBudgets,
  };
};

const start = {
  executionId: "execution-1",
  threadId: "thread-1",
  start: "chat-workflow-start",
  contexts: DEFAULT_CONTEXT_VALUES,
};

const breachOf = (run: () => void): BudgetExceededError => {
  try {
    run();
  } catch (error) {
    if (error instanceof BudgetExceededError) return error;
    throw error;
  }
  throw new Error("no budget was exhausted");
};

describe("#1318a: a token budget counts tokens, and a $0 call is spend", () => {
  it("stops an execution whose unpriced calls use the tokens, though no dollar is spent", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const { meter } = await continuedExecutionBudgets(await deps(ledger), [tokenBudget(100)], []);

    await meter.record([call(60)]);
    expect(() => { meter.check([], ["agent"]); }).not.toThrow();
    await meter.record([call(60)]);
    const error = breachOf(() => { meter.check([], ["agent"]); });

    expect(error.unit).toBe(BudgetUnit.Tokens);
    expect(error).toMatchObject({ maxTokens: 100, usedTokens: 120, spent: 0 });
    expect(error.maxSpend).toBeUndefined();
    expect(error.message).toContain("120 tokens");
    expect(error.message).not.toContain("$");
  });

  it("writes the $0 call to the ledger with its tokens: the counter holds them", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const record = tokenBudget(1000);
    const { meter } = await continuedExecutionBudgets(await deps(ledger), [record], []);

    await recorder(meter, [])([call(40), call(8)]);

    expect(await ledger.findUsageByCounter(counterOf(record, clock.now()))).toEqual({
      spent: 0,
      tokens: 48,
    });
  });

  it("a tally of an unpriced call aborts the in-flight calls once the token cap is reached", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const { meter } = await continuedExecutionBudgets(await deps(ledger), [tokenBudget(50)], []);

    meter.tally([call(80)], ["agent"]);

    expect(meter.exhausted.aborted).toBe(true);
    expect(meter.exhausted.reason).toBeInstanceOf(BudgetExceededError);
    await meter.settled();
    expect(meter.remainingTokens()).toBe(-30);
  });

  it("a token-only budget has no dollar left to claim: remaining() is infinite, never NaN", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const { meter } = await continuedExecutionBudgets(await deps(ledger), [tokenBudget(100)], []);
    await meter.record([call(30)]);

    expect(meter.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(meter.budgetUsd()).toBe(Number.POSITIVE_INFINITY);
    expect(meter.remainingTokens()).toBe(70);
  });

  it("enforces dollars and tokens together: the first cap reached names its unit", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const dollars = await continuedExecutionBudgets(
      await deps(ledger),
      [bothBudget(1, 10_000)],
      [],
    );
    await dollars.meter.record([call(10, 1.5)]);
    expect(breachOf(() => { dollars.meter.check([], []); }).unit).toBe(BudgetUnit.Usd);

    const other = new InMemoryCostLedgerRepository();
    const tokens = await continuedExecutionBudgets(await deps(other), [bothBudget(100, 20)], []);
    await tokens.meter.record([call(25, 0.01)]);
    const error = breachOf(() => { tokens.meter.check([], []); });
    expect(error.unit).toBe(BudgetUnit.Tokens);
    expect(error.maxSpend).toBe(100);
  });

  it("a token count that is no count is refused: NaN would never reach a cap", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const entry: LedgerEntry = {
      ...call(10),
      inputTokens: Number.NaN,
      ledgerId: "l-1",
      madeAt: clock.now(),
    };

    await expect(ledger.saveAll([counterOf(tokenBudget(5), clock.now())], [entry])).rejects.toThrow(
      /inputTokens/,
    );
  });

  it("a restart of a pass counts the tokens its state held once, not again", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const record = tokenBudget(100);
    const first = await continuedExecutionBudgets(await deps(ledger), [record], []);
    await first.meter.record([call(60)]);
    const written = [call(60)];

    const next = await continuedExecutionBudgets(await deps(ledger), [record], written, undefined);

    expect(next.meter.remainingTokens()).toBe(100 - 60 - 60 + 60);
  });
});

describe("#1318a: a pruned ledger keeps its tokens", () => {
  it("deleteByMadeAtBefore removes entries, never what the counters hold", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const record = tokenBudget(1000);
    const counter = counterOf(record, clock.now());
    const entry = (id: string, tokens: number): LedgerEntry => ({
      ...call(tokens, 0.5),
      ledgerId: id,
      madeAt: new Date(clock.now().getTime() - 1000),
    });
    await ledger.saveAll([counter], [entry("a", 40), entry("b", 8)]);

    await ledger.deleteByMadeAtBefore(new Date(clock.now().getTime() + 1000));

    expect(await ledger.findUsageByCounter(counter)).toEqual({ spent: 1, tokens: 48 });
    // a retried save of a pruned entry is refused, never counted twice
    await expect(ledger.saveAll([counter], [entry("a", 40)])).rejects.toThrow();
    expect(await ledger.findUsageByCounter(counter)).toEqual({ spent: 1, tokens: 48 });
  });
});

describe("#1318a: concurrent spends race a cap", () => {
  it("every instance's write lands once, and each is stopped by the sum", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const record = (key: string): ExecutionBudgetRecord => ({
      budget: { name: "tenant-token-budget" },
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Day,
      key,
      maxTokens: 100,
    });
    const meters = await Promise.all(
      Array.from({ length: 5 }, async () =>
        continuedExecutionBudgets(await deps(ledger), [record("acme")], []),
      ),
    );

    await Promise.all(meters.map(({ meter }) => meter.record([call(30)])));
    await Promise.all(meters.map(({ meter }) => meter.refresh()));

    const counter = counterOf(record("acme"), clock.now());
    expect((await ledger.findUsageByCounter(counter)).tokens).toBe(150);
    for (const { meter } of meters)
      expect(breachOf(() => { meter.check([], []); }).usedTokens).toBeGreaterThanOrEqual(100);
  });
});

@Budget({
  name: "tier-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  maxTokens: 100,
})
class TierBudget {}

const workflowClasses = Array.from({ length: 5 }, (_, index) => {
  @Workflow({
    name: `tier-${String(index)}-workflow`,
    version: "1.0.0",
    flow: [],
    budget: TierBudget,
  })
  class Attached {}
  return Attached;
});

describe("#1318a: a shared @Budget has one counter, keyed by the budget", () => {
  it("five workflows that attach it find the same budget, never five", () => {
    for (const workflow of workflowClasses) {
      const found = budgetsOfExecution([], workflow);
      expect(found.map(({ meta }) => meta.name)).toEqual(["tier-budget"]);
    }
  });

  it("their spend lands in one tenant counter: the cap is 100 tokens in all, not 100 each", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const opened = await Promise.all(
      workflowClasses.map(async (workflow) =>
        openExecutionBudgets(await deps(ledger, [], workflow), {
          ...start,
          executionId: `execution-${workflow.name}`,
        }),
      ),
    );
    const accounts = new Set(opened.flatMap(({ records }) => records.map(counterKeyOf)));
    expect(accounts.size).toBe(1);

    for (const { meter } of opened) await meter.record([call(25)]);
    const [last] = opened.slice(-1);
    await last?.meter.refresh();

    expect(breachOf(() => last?.meter.check([], [])).usedTokens).toBe(125);
  });

  it("is found without being listed in @Application({ budgets }): the tenant cap needs no listing", () => {
    @Budget({ name: "default-execution-budget", scope: BudgetScope.Execution, maxSpend: usd(1) })
    class DefaultExecution {}
    @Budget({
      name: "daily-application-budget",
      scope: BudgetScope.Application,
      period: BudgetPeriod.Day,
      maxSpend: usd(10),
    })
    class DailyApplication {}

    expect(
      budgetRuleViolations({
        name: "shop",
        workflows: workflowClasses,
        budgets: [DefaultExecution, DailyApplication],
        tenantContext: Object,
      }),
    ).toEqual([]);
  });
});

const counterKeyOf = (record: ExecutionBudgetRecord): string =>
  JSON.stringify(counterOf(record, clock.now()));
