/**
 * #1090 — a model router's spend is tallied at its call, as an agent's is: in the cost ledger and
 * marked before it reaches the state, so a recovery that applies the router step's saved writes
 * never leaves it out of the ledger, a normal run writes it once, and a router over its budget stops
 * at the call, before the charge after it.
 */
import { beforeEach, describe, expect } from "vitest";
import { BudgetExceededError } from "../../src/index.js";
import { BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, type ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { CostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { routeTo, testWith } from "../../src/testing/index.js";
import { seconds, usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { passLive } from "../helpers/live-time.js";
import { ends, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { book, ChargeOrderAction, resetFencedEffect } from "./fixtures/fenced-effect.workflow.js";
import { instance, rejectionOf } from "./fixtures/fence-takeover.js";
import {
  OrderRouter,
  RoutedChargeWorkflowStart,
  RouterSpendApplication,
} from "./fixtures/router-spend.workflow.js";
import { resetWindow, window } from "./fixtures/writes-window.application.js";

const test = testWith(RouterSpendApplication, { instances: 2 });

beforeEach(() => {
  resetWindow();
  resetFencedEffect();
  resetRecovery();
});

/** What the ledger holds for the execution's budget. */
async function spentOn(
  app: ReturnType<typeof instance>,
  executionId: string,
  now: Date,
): Promise<number> {
  const record: ExecutionBudgetRecord = {
    budget: { name: "router-execution-budget" },
    scope: BudgetScope.Execution,
    key: executionId,
    maxSpend: 0,
  };
  return app
    .resolve(CostLedgerRepository)
    .findUsageByCounter(counterOf(record, now))
    .then((usage) => usage.spent);
}

describe("#1090: a model router's spend is tallied at its call", () => {
  test("a normal run writes the router's cost to the ledger once", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(OrderRouter).thenReturn(routeTo(ChargeOrderAction, { cost: usd(0.4) }));
    const a = instance(apps, 0);
    await a.ready();

    const done = await execute(a, RoutedChargeWorkflowStart, { text: "order-1" });

    expect(done.spend.totalUsd).toBeCloseTo(0.4);
    expect(await spentOn(a, done.executionId, clock.now())).toBeCloseTo(0.4);
  });

  test("a router over its budget stops at its call: the charge after it never runs", async ({
    apps,
    mockLlm,
  }) => {
    mockLlm(OrderRouter).thenReturn(routeTo(ChargeOrderAction, { cost: usd(5) }));
    const a = instance(apps, 0);
    await a.ready();

    const error = await rejectionOf(execute(a, RoutedChargeWorkflowStart, { text: "order-2" }));

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect(book.charges).toEqual([]);
  });

  test("a router step whose writes were saved and whose holder lost the tree: its cost is in the ledger once", async ({
    apps,
    clock,
    mockLlm,
  }) => {
    mockLlm(OrderRouter).thenReturn(routeTo(ChargeOrderAction, { cost: usd(0.4) }));
    const [a, b] = [instance(apps, 0), instance(apps, 1)];
    await a.ready();
    await b.ready();
    // the router's writes are the third task's: the put after them never answers
    window.hangPut = 4;

    const failure = rejectionOf(execute(a, RoutedChargeWorkflowStart, { text: "order-3" }));
    await passLive(clock, seconds(40));
    await failure;
    window.hangPut = 0;
    await passLive(clock, seconds(60));
    await ends(1);

    expect(book.charges).toHaveLength(1);
    expect(await spentOn(b, "execution-1", clock.now())).toBeCloseTo(0.4);
  });
});
