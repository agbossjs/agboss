/**
 * #1318a — every path that lists an application's budgets sees the ones a workflow attaches with
 * `@Workflow({ budget })` without the application listing them: the application's spend view, the
 * limit lookup, the checks before a call, the mesh claim and `describe`. A path that missed one
 * would let spend run past a limit it never saw.
 */
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { standaloneBudgetsOf } from "../../src/application/application-container.js";
import { budgetsOf } from "../../src/application/create-app.js";
import { describedApplicationOf } from "../../src/describe/application.js";
import { Budget, BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import {
  isApplicationSpendExhausted,
  recordApplicationSpend,
} from "../../src/budgets/application-spend.js";
import type { ApplicationBudgets } from "../../src/budgets/budget-check.js";
import { budgetRuleViolations } from "../../src/budgets/budget-rules.js";
import type { Class } from "../../src/components/injection.js";
import { DEFAULT_CONTEXT_VALUES } from "../../src/flow/context/context-values.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { recordToolCost } from "../../src/finops/usage.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { openExecutionBudgets } from "../../src/run/run-budgets.js";
import type { AgentExecutionDeps } from "../../src/run/types.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { EmptyEnvironment, Ttl } from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { WorkflowFinish } from "../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../src/flow/decorators/workflow-start.js";
import { onStart } from "../helpers/flow.js";
import { usd } from "../../src/units/index.js";
import { fakeDeps } from "../helpers.js";

/** The application-wide cap, attached by one workflow and listed nowhere. */
@Budget({
  name: "attached-daily-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
  maxSpend: usd(2),
})
class AttachedApplicationBudget {}

/** The tenant cap, in tokens, attached and listed nowhere. */
@Budget({
  name: "attached-daily-tenant-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  maxTokens: 1000,
})
class AttachedTenantBudget {}

@Budget({ name: "attached-own-execution-budget", scope: BudgetScope.Execution, maxSpend: usd(0.5) })
class AttachedExecutionBudget {}

@Budget({ name: "listed-default-execution-budget", scope: BudgetScope.Execution, maxSpend: usd(9) })
class ListedDefaultBudget {}

/** A workflow that goes from its start to its finish, and attaches `budget` when it has one. */
const workflowOf = (name: string, budget?: Class): Class => {
  @WorkflowStart({
    name: `${name}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `${name}-workflow-finish`,
    description: "The answer",
    output: WorkflowStartTextDto,
  })
  class Finish {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(Start).toFinish(Finish)],
    ...(budget === undefined ? {} : { budget }),
  })
  class Attaching {}
  return Attaching;
};

const CappedWorkflow = workflowOf("capped", AttachedApplicationBudget);
const TenantCappedWorkflow = workflowOf("tenant-capped", AttachedTenantBudget);
const OwnBudgetWorkflow = workflowOf("own-budget", AttachedExecutionBudget);
const PlainWorkflow = workflowOf("plain");

@Application({
  name: "parity-shop-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CappedWorkflow, TenantCappedWorkflow, OwnBudgetWorkflow, PlainWorkflow],
  budgets: [ListedDefaultBudget],
})
class ParityApplication {}

const clock = new VirtualClock(new Date("2026-10-20T12:00:00.000Z"));

/** The application's budgets as the running application hands them to its workflows. */
const budgetsOfApp = async (ledger: InMemoryCostLedgerRepository): Promise<ApplicationBudgets> => ({
  ...budgetsOf(await applicationOf(ParityApplication)),
  resolve: (cls: Class) => new (cls as new () => object)(),
  ledger,
  clock,
});

const openedFor = async (workflow: Class, budgets: ApplicationBudgets, executionId: string) => {
  const base = await fakeDeps({}, {});
  const deps: AgentExecutionDeps<string> = {
    ...base,
    graph: { ...base.graph, type: workflow },
    budgets,
  };
  return openExecutionBudgets(deps, {
    executionId,
    threadId: `thread-${executionId}`,
    start: "chat-workflow-start",
    contexts: DEFAULT_CONTEXT_VALUES,
  });
};

const firstWorkflowOf = (assembled: Awaited<ReturnType<typeof applicationOf>>) => {
  const [first] = assembled.workflows;
  if (first === undefined) throw new Error("the application lists workflows");
  return first;
};

const namesOf = (classes: readonly Class[]): readonly string[] => classes.map((cls) => cls.name);

describe("#1318a: one list of an application's budgets, attached ones included", () => {
  it("the assembly lists the attached budgets beside the listed ones, each once", async () => {
    const assembled = await applicationOf(ParityApplication);

    expect(namesOf(assembled.budgets)).toEqual([
      "ListedDefaultBudget",
      "AttachedApplicationBudget",
      "AttachedTenantBudget",
      "AttachedExecutionBudget",
    ]);
    expect(namesOf(budgetsOf(assembled).attached ?? [])).toEqual([
      "AttachedApplicationBudget",
      "AttachedTenantBudget",
      "AttachedExecutionBudget",
    ]);
    expect(standaloneBudgetsOf(firstWorkflowOf(assembled))?.budgets).toEqual(assembled.budgets);
  });

  it("no rule asks for a listing of an attached budget", () => {
    expect(
      budgetRuleViolations({
        name: "parity-shop-application",
        workflows: [CappedWorkflow, PlainWorkflow],
        budgets: [ListedDefaultBudget],
      }).map((violation) => violation.code),
    ).not.toContain("budget.application-budget-required");
  });
});

describe("#1318a: the spend a workflow makes counts in an application budget another one attached", () => {
  it("a workflow that attached nothing is stopped by the application cap, never past it", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const budgets = await budgetsOfApp(ledger);
    // one execution of the attaching workflow reads the cap into the ledger
    await openedFor(CappedWorkflow, budgets, "capped-1");

    const { meter } = await openedFor(PlainWorkflow, budgets, "plain-1");
    await meter.record([recordToolCost("tool", 2.5)]);
    await meter.refresh();

    expect(() => {
      meter.check([], ["agent"]);
    }).toThrow(LimitError.Budget);
  });

  it("the mesh claim of that workflow is what the application cap has left", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const budgets = await budgetsOfApp(ledger);

    const { meter } = await openedFor(PlainWorkflow, budgets, "plain-2");
    await meter.record([recordToolCost("tool", 0.75)]);
    await meter.refresh();

    // the default execution budget alone would say $8.25
    expect(meter.remaining()).toBeCloseTo(1.25, 10);
  });

  it("a tenant token cap attached by one workflow caps every workflow's tenant", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const budgets = await budgetsOfApp(ledger);

    const { meter } = await openedFor(PlainWorkflow, budgets, "plain-3");

    expect(meter.remainingTokens()).toBe(1000);
  });

  it("a workflow's own attached execution budget is no other workflow's default", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const budgets = await budgetsOfApp(ledger);

    const plain = await openedFor(PlainWorkflow, budgets, "plain-4");
    const own = await openedFor(OwnBudgetWorkflow, budgets, "own-1");

    const names = (opened: typeof plain): string[] => opened.records.map((r) => r.budget.name);
    expect(names(plain)).toContain("listed-default-execution-budget");
    expect(names(plain)).not.toContain("attached-own-execution-budget");
    expect(names(own)).toContain("attached-own-execution-budget");
    expect(names(own)).not.toContain("listed-default-execution-budget");
  });
});

describe("#1318a: the application's spend outside an execution sees the attached budget", () => {
  const standaloneOf = async (
    ledger: InMemoryCostLedgerRepository,
  ): Promise<ApplicationBudgets> => {
    const assembled = await applicationOf(ParityApplication);
    const listing = standaloneBudgetsOf(firstWorkflowOf(assembled));
    if (listing === undefined) throw new Error("the workflow is listed by the application");
    return { ...listing, resolve: (cls) => new (cls as new () => object)(), ledger, clock };
  };

  it("an evaluation's judge calls count in it and, over its last known limit, exhaust it", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const application = await standaloneOf(ledger);
    // an execution read the limit, the way the framework keeps the last known one in the ledger
    await openedFor(CappedWorkflow, application, "capped-2");
    expect(await isApplicationSpendExhausted(application)).toBe(false);

    await recordApplicationSpend(application, [recordToolCost("judge", 2.5)]);

    expect(await isApplicationSpendExhausted(application)).toBe(true);
  });

  it("the limit an execution of another workflow read is kept for it, and found by its account", async () => {
    const ledger = new InMemoryCostLedgerRepository();
    const application = await standaloneOf(ledger);
    // a workflow that attached nothing runs: the limit of the budget another one attached is kept
    await openedFor(PlainWorkflow, application, "plain-5");

    const known = await ledger.findLimitByAccount({
      budget: "attached-daily-application-budget",
      scope: BudgetScope.Application,
      key: "parity-shop-application",
    });

    expect(known?.maxSpend).toBe(2);
  });
});

describe("#1318a: describe", () => {
  it("lists the attached budgets, and names the listed default for a workflow without its own", async () => {
    const described = describedApplicationOf(await applicationOf(ParityApplication));

    expect(described.budgets.map((budget) => budget.name)).toContain(
      "attached-daily-application-budget",
    );
    const plain = described.executionBudgets.find((one) => one.workflow === "plain-workflow");
    expect(plain).toMatchObject({ name: "listed-default-execution-budget", isOwn: false });
  });
});
