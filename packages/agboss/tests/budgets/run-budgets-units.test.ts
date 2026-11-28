/**
 * #1356 — the budgets of a pass in the run layer: none without an application, those an execution keeps
 * met again from its state, and the recorder that writes each call's cost into their counters.
 */
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../src/budgets/budget-check.js";
import type { ApplicationBudgets } from "../../src/budgets/budget-check.js";
import { deadlineFrom } from "../../src/budgets/execution-deadline.js";
import { DEFAULT_CONTEXT_VALUES } from "../../src/flow/context/context-values.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import {
  CALLER_BUDGET,
  continuedExecutionBudgets,
  inStartFrame,
  openExecutionBudgets,
  recorder,
} from "../../src/run/run-budgets.js";
import type { AgentExecutionDeps } from "../../src/run/types.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { usd } from "../../src/units/index.js";
import { currentFrame } from "../../src/flow/context/frame.js";
import type { ExecutionOrigin } from "../../src/mesh/mesh-envelope.js";
import { fakeDeps, usageRecord } from "../helpers.js";

/** Run dependencies that hold no budgets: the only member the functions read before they return. */
const withoutBudgets = (): AgentExecutionDeps<string> => {
  const deps = {};
  const isDeps = (value: object): value is AgentExecutionDeps<string> => value === deps;
  if (!isDeps(deps)) throw new Error("unreachable");
  return deps;
};

const clock = new VirtualClock();

/** Run dependencies of an application with budgets: the members the functions read. */
const withBudgets = (ledger: InMemoryCostLedgerRepository): AgentExecutionDeps<string> => {
  const budgets: ApplicationBudgets = {
    budgets: [],
    applicationName: "shop",
    resolve: () => ({ maxSpend: () => usd(0) }),
    ledger,
    clock,
  };
  const deps = { budgets };
  const isDeps = (value: object): value is AgentExecutionDeps<string> => value === deps;
  if (!isDeps(deps)) throw new Error("unreachable");
  return deps;
};

const own: ExecutionBudgetRecord = {
  budget: { name: "own-execution-budget" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 10,
};

const tenant: ExecutionBudgetRecord = {
  budget: { name: "tenant-daily-budget" },
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  key: "acme",
  maxSpend: 10,
};

describe("#1356: no application, no budgets", () => {
  it("a new execution is checked against nothing and keeps no record", async () => {
    const start = { executionId: "execution-1", start: "start", contexts: DEFAULT_CONTEXT_VALUES };

    const { meter, records } = await openExecutionBudgets(withoutBudgets(), start);

    expect(records).toStrictEqual([]);
    expect(meter.records).toStrictEqual([]);
    expect(meter.remaining()).toBe(Number.POSITIVE_INFINITY);
    expect(meter.budgetUsd()).toBe(Number.POSITIVE_INFINITY);
    // its spend still counts, in a ledger of its own
    await meter.record([usageRecord("agent", 2)]);
    expect(meter.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it("a later pass keeps none of the records its state holds", async () => {
    const { meter, records } = await continuedExecutionBudgets(
      withoutBudgets(),
      [own],
      [usageRecord("agent", 3)],
    );

    expect(records).toStrictEqual([]);
    expect(meter.records).toStrictEqual([]);
    expect(meter.budgetUsd()).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("#1356: a later pass of an execution of an application", () => {
  it("keeps the records of its state, and counts what it spent before beside what the ledger holds", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const deps = withBudgets(ledger);
    // 4 are in the tenant's counter already, written by a pass before
    const before = await continuedExecutionBudgets(deps, [tenant], []);
    await recorder(before.meter, [])([usageRecord("earlier", 4)]);

    const { meter, records } = await continuedExecutionBudgets(
      deps,
      [tenant],
      [usageRecord("a", 3)],
    );

    expect(records).toStrictEqual([tenant]);
    expect(meter.records).toStrictEqual([tenant]);
    expect(meter.budgetUsd()).toBe(10 - 4 + 3);
  });

  it("keeps none when its state holds none", async () => {
    const deps = withBudgets(new InMemoryCostLedgerRepository());

    const { meter, records } = await continuedExecutionBudgets(deps, undefined, []);

    expect(records).toStrictEqual([]);
    expect(meter.records).toStrictEqual([]);
    expect(meter.remaining()).toBe(Number.POSITIVE_INFINITY);
  });

  it("is given the execution's deadline", async () => {
    const deadline = deadlineFrom(clock.now(), 30_000);

    const { meter } = await continuedExecutionBudgets(
      withBudgets(new InMemoryCostLedgerRepository()),
      [own],
      [],
      deadline,
    );

    expect(meter.deadline).toBe(deadline);
  });
});

describe("#1356: the recorder of a pass", () => {
  it("remembers each call's spend for the turn and writes it into the counters", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const { meter } = await continuedExecutionBudgets(withBudgets(ledger), [own], []);
    const spent: ReturnType<typeof usageRecord>[] = [];
    const record = recorder(meter, spent);

    await record([usageRecord("a", 2)]);
    await record([usageRecord("b", 3), usageRecord("c", 1)]);

    expect(spent.map((each) => each.caller)).toEqual(["a", "b", "c"]);
    expect((await ledger.findUsageByCounter(counterOf(own, clock.now()))).spent).toBe(6);
  });
});

describe("#1356: the budget a trusted caller sets", () => {
  it("is named by the built-in name", () => {
    expect(CALLER_BUDGET).toBe("caller-budget");
  });
});

const ORIGIN: ExecutionOrigin = {
  application: "orders-application",
  hops: 1,
  rootExecutionId: "caller-root",
  executionId: "caller-execution",
  workflow: { name: "orders-workflow", version: "1.0.0" },
  step: { component: "pay-step", idempotencyKey: "caller-execution:pay-step:1" },
};

describe("#1356: the budgets of a new execution of an application", () => {
  const startOf = (contexts = DEFAULT_CONTEXT_VALUES) => ({
    executionId: "execution-1",
    threadId: "thread-1",
    start: "chat-workflow-start",
    contexts,
  });

  it("keeps a record per budget: the execution's own with no period, the tenant's and the application's with theirs", async () => {
    const deps = await fakeDeps({}, { executionBudget: 5 });

    const { meter, records } = await openExecutionBudgets(deps, startOf());

    expect(records).toStrictEqual([
      expect.objectContaining({ scope: BudgetScope.Application, period: BudgetPeriod.Day }),
      expect.objectContaining({ scope: BudgetScope.Tenant, period: BudgetPeriod.Day }),
      {
        budget: { name: "test-execution-budget" },
        scope: BudgetScope.Execution,
        key: "execution-1",
        maxSpend: 5,
      },
    ]);
    expect(meter.records).toStrictEqual(records);
    expect(meter.remaining()).toBe(5);
  });

  it("is refused before its first step when a budget has nothing left, with no usage to place", async () => {
    const deps = await fakeDeps({}, { executionBudget: 0 });

    const refused: unknown = await openExecutionBudgets(deps, startOf()).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(LimitError.Budget);
    expect(refused).toMatchObject({
      budget: { name: "test-execution-budget" },
      spent: 0,
      path: [],
      usage: [],
    });
  });

  it("is capped by what a trusted caller has left, beside its own budgets", async () => {
    const deps = await fakeDeps({}, { executionBudget: 5 });
    const trusted = { origin: ORIGIN, budget: 2 };
    const contexts = { ...DEFAULT_CONTEXT_VALUES, mesh: { chain: [], trusted } };

    const { meter, records } = await openExecutionBudgets(deps, startOf(contexts));

    expect(records.at(-1)).toStrictEqual({
      budget: { name: CALLER_BUDGET },
      scope: BudgetScope.Execution,
      key: "execution-1",
      maxSpend: 2,
    });
    expect(records).toHaveLength(4);
    expect(meter.remaining()).toBe(2);
  });

  it("is capped by the tokens a trusted caller has left, as its own cap beside any dollar claim", async () => {
    const deps = await fakeDeps({}, { executionBudget: 5 });
    const tokensOnly = { origin: ORIGIN, budgetTokens: 500 };
    const both = { origin: ORIGIN, budget: 2, budgetTokens: 500 };

    const only = await openExecutionBudgets(
      deps,
      startOf({ ...DEFAULT_CONTEXT_VALUES, mesh: { chain: [], trusted: tokensOnly } }),
    );
    const claimed = await openExecutionBudgets(
      deps,
      startOf({ ...DEFAULT_CONTEXT_VALUES, mesh: { chain: [], trusted: both } }),
    );

    expect(only.records.at(-1)).toStrictEqual({
      budget: { name: CALLER_BUDGET },
      scope: BudgetScope.Execution,
      key: "execution-1",
      maxTokens: 500,
    });
    expect(claimed.records.at(-1)).toStrictEqual({
      budget: { name: CALLER_BUDGET },
      scope: BudgetScope.Execution,
      key: "execution-1",
      maxSpend: 2,
      maxTokens: 500,
    });
  });

  it("claims nothing for a mesh request with no trusted claim, or a trusted one without a budget", async () => {
    const deps = await fakeDeps({}, { executionBudget: 5 });
    const claims = [{ chain: [] }, { chain: [], trusted: { origin: ORIGIN } }];

    for (const mesh of claims) {
      const { records } = await openExecutionBudgets(
        deps,
        startOf({ ...DEFAULT_CONTEXT_VALUES, mesh }),
      );
      expect(records.map((record) => record.budget.name)).not.toContain(CALLER_BUDGET);
      expect(records).toHaveLength(3);
    }
  });
});

describe("#1356: the frame of a start", () => {
  it("names the graph's own component when its start is no node of it", async () => {
    const deps = await fakeDeps({});
    const start = {
      executionId: "execution-1",
      start: "no-such-node",
      contexts: DEFAULT_CONTEXT_VALUES,
    };

    const frame = await inStartFrame(deps, start)(() => Promise.resolve(currentFrame()));

    expect(frame?.step.component.type).toBe(deps.graph.type);
    expect(frame?.step.nodeId).toBe("no-such-node");
    expect(frame?.execution.executionId).toBe("execution-1");
  });
});
