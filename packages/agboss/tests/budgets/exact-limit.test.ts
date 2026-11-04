/**
 * #728 — a budget's spend is compared with its limit in integer micro-units (USD × 10⁶, rounded):
 * eight $0.10 calls (a float sum of 0.7999999999999999) exhaust a $0.80 budget — in the meter's
 * check and tally, at a new execution's admission and for the application's spend outside an
 * execution —, and a spend a micro-dollar under the limit still passes.
 */
import { describe, expect, it } from "vitest";
import {
  Action,
  BudgetExceededError,
  EmptyEnvironment,
  SpendRecorder,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import { isApplicationSpendExhausted } from "../../src/budgets/application-spend.js";
import { Budget, type BudgetHandler } from "../../src/budgets/budget.js";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { counterOf, meterOf } from "../../src/budgets/execution-budgets.js";
import type { ExecutionBudgetRecord } from "../../src/budgets/execution-budgets.js";
import { recordToolCost } from "../../src/finops/usage.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { testWith } from "../../src/testing/index.js";
import { usd, type Usd } from "../../src/units/index.js";
import { TEST_BUDGETS, TestTenantDailyBudget } from "../flow/fixtures/budgets.js";
import { execute, start } from "../helpers/flow.js";
import { ItemDto, ItemResultDto } from "../flow/runtime/fixtures/fan-out.workflow.js";

const EIGHT_DIMES = Array.from({ length: 8 }, () => recordToolCost("search-tool", 0.1));
const EXECUTION: ExecutionBudgetRecord = {
  budget: { name: "execution" },
  scope: BudgetScope.Execution,
  key: "execution-1",
  maxSpend: 0.8,
};

describe("#728 AC1: eight $0.10 calls exhaust $0.80", () => {
  it("the meter's tally and its check before the next step", () => {
    const meter = meterOf(
      { ledger: new InMemoryCostLedgerRepository(), clock: systemClock },
      [EXECUTION],
      0,
    );

    meter.tally(EIGHT_DIMES);

    expect(meter.exhausted.aborted).toBe(true);
    expect(() => { meter.check(0, []); }).toThrow(BudgetExceededError);
  });

  it("the application's spend outside an execution, held to the last known limit", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const application = {
      budgets: [DailyApplicationBudget],
      applicationName: "exact-application",
      resolve: () => new DailyApplicationBudget(),
      ledger,
      clock: systemClock,
    };
    const record = {
      budget: { name: "daily-application-budget" },
      scope: BudgetScope.Application,
      period: BudgetPeriod.Day,
      key: "exact-application",
      maxSpend: 0.8,
    };
    await ledger.saveMaxSpend(
      {
        budget: "daily-application-budget",
        scope: BudgetScope.Application,
        key: "exact-application",
      },
      usd(0.8),
    );
    await ledger.saveAll([counterOf(record, systemClock.now())], EIGHT_DIMES);

    await expect(isApplicationSpendExhausted(application)).resolves.toBe(true);
  });
});

describe("#728 AC2: a micro-dollar under the limit passes", () => {
  it("$0.799999 of $0.80: the next step runs", () => {
    const meter = meterOf(
      { ledger: new InMemoryCostLedgerRepository(), clock: systemClock },
      [EXECUTION],
      0,
    );

    meter.tally([recordToolCost("search-tool", 0.799999)]);

    expect(meter.exhausted.aborted).toBe(false);
    expect(() => { meter.check(0, []); }).not.toThrow();
  });
});

@Budget({
  name: "daily-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
class DailyApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.8);
  }
}

@Action({
  name: "dimes-action",
  description: "Eight calls of $0.10",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [SpendRecorder],
})
class DimesAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}
  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    for (let call = 0; call < 8; call += 1)
      this.spendRecorder.record({ service: "search", cost: usd(0.1) });
    return Promise.resolve({ name: input.item.value.name });
  }
}
@WorkflowStart({ name: "dimes-workflow-start", description: "An item", input: ItemDto })
class DimesStart {}
@WorkflowFinish({ name: "dimes-workflow-finish", description: "Done", output: ItemResultDto })
class DimesFinish {}
@Workflow({
  name: "dimes-workflow",
  version: "1.0.0",
  flow: [
    start(DimesStart)
      .returns(ItemDto)
      .toAction(DimesAction)
      .returns(ItemResultDto)
      .toFinish(DimesFinish),
  ],
})
class DimesWorkflow {}
@Application({
  name: "dimes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DimesWorkflow],
  budgets: TEST_BUDGETS,
})
class DimesApplication {}

describe("#728 AC1: a new execution's admission", () => {
  const test = testWith(DimesApplication);
  test("the tenant spent $0.80 in eight dimes of its $0.80: the next execution is rejected", async ({
    app,
    mockOf,
  }) => {
    mockOf(TestTenantDailyBudget).maxSpend.mockReturnValue(usd(0.8));
    const item = { name: "a", delay: 0, outcome: "ok" };
    await execute(app, DimesStart, item);

    await expect(execute(app, DimesStart, item)).rejects.toFailWith(BudgetExceededError, {
      scope: BudgetScope.Tenant,
    });
  });
});
