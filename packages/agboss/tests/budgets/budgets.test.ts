/**
 * #261 AC10 (PR 5): budgets at run time — every workflow, every tenant and the whole application
 * capped (assembly), `maxSpend()` read once per execution (in the execution's context), every
 * budget checked before the first step (an exhausted one rejects the execution) and counted after
 * every model call (the first exhausted stops it with `BudgetExceededError`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { periodStartOf } from "../../src/budgets/budget-period.js";
import {
  Budget,
  BudgetExceededError,
  BudgetPeriod,
  BudgetScope,
  CostLedgerRepository,
  EmptyEnvironment,
  GraphRuleError,
  type BudgetHandler,
} from "../../src/index.js";
import { replyWith, routeTo, testExecutionContext, testWith } from "../../src/testing/index.js";
import type { Class } from "../../src/components/injection.js";
import { usd, type Usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  BriefExecutionBudget,
  BriefFinish,
  BriefStart,
  BriefWorkflow,
  DraftDto,
  DrafterAgent,
  maxSpendReads,
  ReviewerAgent,
  ShopApplication,
  ShopApplicationDailyBudget,
  ShopTenantContext,
  ShopTenantDailyBudget,
  ShopTenantMonthlyBudget,
  shopLedgers,
} from "./fixtures/budgets.application.js";
import {
  CheapEditApplication,
  DraftDto as EditDraftDto,
  EditorAgent,
  EditStart,
  GateRouter,
} from "../flow/runtime/fixtures/edit.workflow.js";

const shop = testWith(ShopApplication);
const cheap = testWith(CheapEditApplication);

const acme = { tenantId: "acme", dailyBudgetUsd: 0.05 };
const draft = (cost: number) => replyWith(DraftDto, { text: "a draft" }, { cost: usd(cost) });

/** The ledger of the test's application instance. */
function lastLedger(): CostLedgerRepository {
  const ledger = shopLedgers.at(-1);
  if (ledger === undefined) throw new Error("the application has not started");
  return ledger;
}

beforeEach(() => {
  maxSpendReads.length = 0;
});

describe("#261 AC10: maxSpend() is read once per execution, in its context", () => {
  shop(
    "one read per budget at the start, the tenant's own amount, the start step's frame",
    async ({ app, mockLlm }) => {
      mockLlm(DrafterAgent).thenReturn(draft(0.001));
      mockLlm(ReviewerAgent).thenReturn(replyWith("fine", { cost: usd(0.001) }));

      await execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

      expect(maxSpendReads).toEqual([
        "shop-tenant-daily-budget@acme",
        "brief-execution-budget@acme:brief-workflow-start",
      ]);
    },
  );

  shop("each execution reads its own amounts", async ({ app, mockLlm }) => {
    mockLlm(DrafterAgent).thenReturnAlways(draft(0));
    mockLlm(ReviewerAgent).thenReturnAlways(replyWith("fine"));

    await execute(app, BriefStart, { text: "one" }, { tenant: acme });
    await execute(app, BriefStart, { text: "two" }, { tenant: { ...acme, tenantId: "globex" } });

    expect(maxSpendReads.filter((read) => read.startsWith("shop-tenant-daily"))).toEqual([
      "shop-tenant-daily-budget@acme",
      "shop-tenant-daily-budget@globex",
    ]);
  });

  shop(
    "the ledger keeps the last maxSpend() of each budget: the last known limit",
    async ({ app, mockLlm }) => {
      mockLlm(DrafterAgent).thenReturn(draft(0));
      mockLlm(ReviewerAgent).thenReturn(replyWith("fine"));

      await execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

      const ledger = lastLedger();
      const account = {
        budget: "shop-tenant-daily-budget",
        scope: BudgetScope.Tenant,
        key: "acme",
      };
      expect(await ledger.findMaxSpendByAccount(account)).toBe(0.05);
    },
  );
});

describe("#261 AC10: every budget is checked before the first step", () => {
  shop(
    "an exhausted tenant budget rejects the execution: no record, no model call",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(ShopTenantDailyBudget).maxSpend.mockReturnValue(usd(0));

      const run = execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

      await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
      await expect(run).rejects.toMatchObject({
        budget: { name: "shop-tenant-daily-budget" },
        scope: BudgetScope.Tenant,
        key: "acme",
        maxSpend: 0,
        spent: 0,
        path: [],
      });
      await expect(run).rejects.toThrow(
        "tenant acme spent $0 today; shop-tenant-daily-budget allows $0",
      );
      expect(mockLlm(DrafterAgent).requests).toHaveLength(0);
      // a refused request leaves no trace: not even the amounts it read
      const account = {
        budget: "shop-tenant-daily-budget",
        scope: BudgetScope.Tenant,
        key: "acme",
      };
      expect(await lastLedger().findMaxSpendByAccount(account)).toBeUndefined();
    },
  );

  shop(
    "an application budget spent by earlier executions rejects the next one",
    async ({ app, mockLlm, mockOf }) => {
      mockOf(ShopApplicationDailyBudget).maxSpend.mockReturnValue(usd(0.01));
      mockLlm(DrafterAgent).thenReturnAlways(draft(0.02));
      mockLlm(ReviewerAgent).thenReturnAlways(replyWith("fine"));

      // the first one passes the check (nothing spent yet) and spends $0.02 in its one paid call
      await expect(
        execute(app, BriefStart, { text: "one" }, { tenant: acme }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      const second = execute(
        app,
        BriefStart,
        { text: "two" },
        { tenant: { ...acme, tenantId: "b" } },
      );

      await expect(second).rejects.toThrow(
        "shop-application spent $0.02 today; shop-application-daily-budget allows $0.01",
      );
      expect(mockLlm(DrafterAgent).requests).toHaveLength(1);
    },
  );
});

describe("#261 AC10: every model call is counted in all of the execution's budgets", () => {
  shop(
    "the first exhausted budget stops the execution before the next call",
    async ({ app, mockLlm }) => {
      mockLlm(DrafterAgent).thenReturn(draft(0.06));

      const run = execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

      await expect(run).rejects.toMatchObject({
        code: "limit.budget",
        budget: { name: "shop-tenant-daily-budget" },
        key: "acme",
        spent: 0.06,
        maxSpend: 0.05,
        path: ["brief-workflow-start", "drafter-agent", "reviewer-agent"],
      });
      expect(mockLlm(ReviewerAgent).requests).toHaveLength(0);
    },
  );

  shop("each call's cost lands in every counter of the execution", async ({ app, mockLlm }) => {
    mockLlm(DrafterAgent).thenReturn(draft(0.01));
    mockLlm(ReviewerAgent).thenReturn(replyWith("fine", { cost: usd(0.02) }));

    const result = await execute(app, BriefStart, { text: "a brief" }, { tenant: acme });

    expect(result).toFinishWith(BriefFinish);
    const ledger = lastLedger();
    const day = app.clock.now().toISOString().slice(0, 10);
    const month = `${day.slice(0, 7)}-01`;
    const spent = (budget: string, scope: BudgetScope, key: string, period: string) =>
      ledger.findSpentByCounter({ budget, scope, key, period });
    expect(await spent("shop-tenant-daily-budget", BudgetScope.Tenant, "acme", day)).toBeCloseTo(
      0.03,
    );
    expect(
      await spent("shop-tenant-monthly-budget", BudgetScope.Tenant, "acme", month),
    ).toBeCloseTo(0.03);
    expect(
      await spent(
        "shop-application-daily-budget",
        BudgetScope.Application,
        "shop-application",
        day,
      ),
    ).toBeCloseTo(0.03);
    expect(
      await spent("brief-execution-budget", BudgetScope.Execution, result.runId, ""),
    ).toBeCloseTo(0.03);
  });

  cheap(
    "the execution budget stops a loop; the tenant's day stops the next execution, then rejects one",
    async ({ app, mockLlm }) => {
      const edit = (cost: number) => replyWith(EditDraftDto, { text: "v" }, { cost: usd(cost) });
      mockLlm(GateRouter).thenReturnAlways(routeTo(EditorAgent));
      mockLlm(EditorAgent).thenReturn(edit(0.016), edit(0.003), edit(0.003));

      // $0.016 > the execution's $0.015: the gate after the editor never runs
      const first = execute(app, EditStart, { text: "one" });
      await expect(first).rejects.toMatchObject({
        budget: { name: "cheap-edit-execution-budget" },
        scope: BudgetScope.Execution,
      });
      await expect(first).rejects.toThrow(
        /^execution .+ spent \$0\.016; cheap-edit-execution-budget allows \$0\.015$/,
      );
      // the tenant's day: $0.016 + $0.003 = $0.019 < $0.02, then one more call crosses it
      const second = execute(app, EditStart, { text: "two" });
      await expect(second).rejects.toMatchObject({ budget: { name: "cheap-tenant-daily-budget" } });
      const third = execute(app, EditStart, { text: "three" });

      await expect(third).rejects.toThrow(
        "tenant default spent $0.022 today; cheap-tenant-daily-budget allows $0.02",
      );
      expect(mockLlm(EditorAgent).requests).toHaveLength(3);
    },
  );
});

describe("#261 AC10: a budget's maxSpend() is unit-tested without the container", () => {
  it("new ShopTenantDailyBudget(testExecutionContext(…).tenant).maxSpend() reads the tenant", () => {
    const context = testExecutionContext({
      tenantContext: ShopTenantContext,
      tenant: { tenantId: "acme", dailyBudgetUsd: 40 },
    });

    expect(new ShopTenantDailyBudget(context.tenant).maxSpend()).toBe(usd(40));
  });

  it("an execution budget reads its execution", () => {
    const budget = new BriefExecutionBudget(testExecutionContext());

    expect(budget.maxSpend()).toBe(usd(0.5));
    expect(maxSpendReads).toEqual(["brief-execution-budget@default:test-step"]);
  });
});

/** An application of BriefWorkflow with the given budgets. */
function applicationWith(budgets: readonly Class[]) {
  @Application({
    name: "budgets-rules-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [BriefWorkflow],
    budgets,
  })
  class BudgetsRulesApplication {}
  return BudgetsRulesApplication;
}

@Budget({ name: "other-execution-budget", scope: BudgetScope.Execution, workflow: BriefWorkflow })
class OtherExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "default-execution-budget", scope: BudgetScope.Execution })
class DefaultExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@Budget({ name: "second-default-execution-budget", scope: BudgetScope.Execution })
class SecondDefaultExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

/** The rule violations an application's assembly fails with. */
async function violationsOf(application: new () => object): Promise<readonly string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  if (!(error instanceof GraphRuleError)) throw new Error("expected the assembly to fail");
  return error.violations.map((violation) => `[${violation.code}] ${violation.message}`);
}

describe("#261 AC10: every workflow, every tenant and the application are capped (assembly)", () => {
  it("[budget.execution-budget-required] / tenant / application — all at once", async () => {
    expect(await violationsOf(applicationWith([]))).toEqual([
      "[budget.execution-budget-required] brief-workflow has no execution budget and there is no default — add one with workflow: BriefWorkflow or one without workflow",
      "[budget.tenant-budget-required] budgets-rules-application has no tenant budget — add a @Budget({ scope: BudgetScope.Tenant, period }) to its budgets",
      "[budget.application-budget-required] budgets-rules-application has no application budget — add a @Budget({ scope: BudgetScope.Application, period }) to its budgets",
    ]);
  });

  it("[budget.duplicate-execution-budget]: two own budgets for one workflow", async () => {
    const budgets = [ShopApplicationDailyBudget, ShopTenantMonthlyBudget, BriefExecutionBudget];
    expect(await violationsOf(applicationWith([...budgets, OtherExecutionBudget]))).toEqual([
      "[budget.duplicate-execution-budget] brief-workflow has 2 execution budgets (brief-execution-budget, other-execution-budget) — keep one with workflow: BriefWorkflow",
    ]);
  });

  it("[budget.duplicate-default-execution-budget]: two budgets without workflow", async () => {
    const budgets = [ShopApplicationDailyBudget, ShopTenantMonthlyBudget, DefaultExecutionBudget];
    expect(await violationsOf(applicationWith([...budgets, SecondDefaultExecutionBudget]))).toEqual(
      [
        "[budget.duplicate-default-execution-budget] budgets-rules-application has 2 default execution budgets (default-execution-budget, second-default-execution-budget) — keep one without workflow",
      ],
    );
  });

  it("the default covers every workflow without its own", async () => {
    const budgets = [ShopApplicationDailyBudget, ShopTenantMonthlyBudget, DefaultExecutionBudget];
    const assembled = await applicationOf(applicationWith(budgets));

    expect(assembled.budgets).toEqual(budgets);
  });
});

describe("#261: BudgetPeriod names its UTC period by its first day", () => {
  it("day, week (from Monday), month", () => {
    const sunday = new Date("2026-10-18T23:59:59.999Z");

    expect(periodStartOf(BudgetPeriod.Day, sunday)).toBe("2026-10-18");
    expect(periodStartOf(BudgetPeriod.Week, sunday)).toBe("2026-10-12");
    expect(periodStartOf(BudgetPeriod.Week, new Date("2026-10-12T00:00:00Z"))).toBe("2026-10-12");
    expect(periodStartOf(BudgetPeriod.Month, sunday)).toBe("2026-10-01");
  });
});
