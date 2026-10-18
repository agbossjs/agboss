/**
 * #261 PR 2: the assembly rules of an `@Application` — names end with their kind, it lists
 * workflows, names are unique in the application, budgets are `@Budget`s, infrastructure is listed
 * only in `@Application({ providers })`, by inheritance — every violation at once.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { Budget, BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import type { Class } from "../../src/components/injection.js";
import { Agent, GraphRuleError, Injectable, Workflow, WorkflowFinish } from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryPausedExecutionRepository } from "../../src/infrastructure/paused-execution.repository.js";
import { usd, type Usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { testDefaults } from "../helpers.js";
import { start } from "../helpers/flow.js";
import {
  OrdersAgent,
  OrdersWorkflow,
  OrdersWorkflowFinish,
  RefundsWorkflowStart,
} from "./fixtures/desks.application.js";
import { EmptyEnvironment } from "../../src/index.js";

/** The codes and messages an application's assembly fails with. */
async function violationsOf(application: Class): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof GraphRuleError))
    throw new Error(`expected a GraphRuleError: ${String(error)}`);
  return error.violations.map((found) => `[${found.code}] ${found.message}`);
}

@Budget({ name: "daily", scope: BudgetScope.Application, period: BudgetPeriod.Day })
class DailyLimit {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** Has the method, not the decorator. */
class NotABudget {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Application({
  name: "misnamed",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [],
  budgets: [DailyLimit, NotABudget],
})
class Misnamed {}

@Agent({ name: "orders-agent", description: "Another", prompt: "Answer.", model: "test/beta" })
class OtherOrdersAgent {}

@WorkflowFinish({ name: "other-workflow-finish", description: "d", output: WorkflowFinishTextDto })
class OtherFinish {}

@Workflow({
  name: "orders-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: [
    start(RefundsWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OtherOrdersAgent)
      .toFinish(OtherFinish),
  ],
})
class SecondOrdersWorkflow {}

@Application({
  name: "clashing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OrdersWorkflow, SecondOrdersWorkflow, OrdersAgent],
  budgets: TEST_BUDGETS,
})
class ClashingApplication {}

@Workflow({
  name: "ledgered-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: [
    start(RefundsWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OrdersAgent)
      .toFinish(OrdersWorkflowFinish),
  ],
  providers: [InMemoryCostLedgerRepository],
})
class LedgeredWorkflow {}

@Application({
  name: "ledgered-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LedgeredWorkflow],
  budgets: TEST_BUDGETS,
})
class LedgeredApplication {}

describe("#261: the rules of an application, all at once", () => {
  it("names end with their kind, a workflow list, budgets that are @Budget", async () => {
    expect(await violationsOf(Misnamed)).toEqual([
      '[name.kind-suffix] "misnamed" on @Application — name it "misnamed-application"',
      "[name.kind-suffix] class Misnamed — name it MisnamedApplication",
      "[application.no-workflows] misnamed lists no workflows — add them: @Application({ workflows: [...] })",
      '[name.kind-suffix] "daily" on @Budget — name it "daily-budget"',
      "[name.kind-suffix] class DailyLimit — name it DailyLimitBudget",
      "[budget.not-a-budget] NotABudget in misnamed's budgets has no @Budget({ name, scope, … }) decorator",
      "[budget.tenant-budget-required] misnamed has no tenant budget — add a @Budget({ scope: BudgetScope.Tenant, period }) to its budgets",
    ]);
  });

  it("a workflow name and a component name are unique in the application", async () => {
    expect(await violationsOf(ClashingApplication)).toEqual([
      "[application.not-a-workflow] OrdersAgent in clashing-application's workflows is not a @Workflow class",
      '[application.duplicate-workflow] OrdersWorkflow and SecondOrdersWorkflow are both named "orders-workflow" — a workflow name is unique in the application',
      '[graph.duplicate-node-name] OrdersAgent and OtherOrdersAgent are both named "orders-agent" — a name is unique in the application; rename one',
    ]);
  });

  it("infrastructure in a workflow's providers fails: it is listed only in @Application", async () => {
    expect(await violationsOf(LedgeredApplication)).toEqual([
      "[di.infrastructure-in-workflow] InMemoryCostLedgerRepository extends CostLedgerRepository — infrastructure is listed only in @Application({ providers }), not in ledgered-workflow's providers",
    ]);
  });
});

@Injectable()
class FirstPausedExecutionRepository extends InMemoryPausedExecutionRepository {}

@Injectable()
class SecondPausedExecutionRepository extends InMemoryPausedExecutionRepository {}

@Application({
  name: "two-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OrdersWorkflow],
  providers: [FirstPausedExecutionRepository, SecondPausedExecutionRepository],
  budgets: TEST_BUDGETS,
})
class TwoPausesApplication {}

describe("#261: an infrastructure contract has one implementation", () => {
  it("two listed implementations of one contract are ambiguous", async () => {
    const { createApp } = await import("../../src/application/create-app.js");

    await expect(createApp(TwoPausesApplication, { processEnv: {} })).rejects.toThrow(
      '[di.ambiguous-implementation] the app depends on PausedExecutionRepository, and 2 listed classes implement it: FirstPausedExecutionRepository (@Application "two-pauses-application"), SecondPausedExecutionRepository (@Application "two-pauses-application") — list one',
    );
  });
});

describe("#261: @Budget options are discriminated by scope", () => {
  it("period is required for a tenant budget and forbidden for an execution budget", () => {
    const tenant = { name: "tenant-budget", scope: BudgetScope.Tenant } as const;
    const execution = {
      name: "execution-budget",
      scope: BudgetScope.Execution,
      period: BudgetPeriod.Day,
    } as const;
    const named = {
      name: "tenant-budget",
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Month,
      workflow: OrdersWorkflow,
    } as const;

    // @ts-expect-error — a tenant budget needs its period
    const noPeriod = Budget(tenant);
    // @ts-expect-error — an execution budget has no period
    const withPeriod = Budget(execution);
    // @ts-expect-error — only an execution budget names its workflow
    const withWorkflow = Budget(named);
    expect([noPeriod, withPeriod, withWorkflow]).toHaveLength(3);
  });
});
