/**
 * #1356 — the rules of an application's budgets (#261 AC10), each on its own: which budgets count,
 * which workflow a message names, the nodes every violation points at, and a budget of one scope
 * never answers for another.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { budgetRuleViolations } from "../../src/budgets/budget-rules.js";
import { periodStartOf, periodWords } from "../../src/budgets/budget-period.js";
import type { Class } from "../../src/components/injection.js";
import { usd, type Usd } from "../../src/units/index.js";
import { BriefWorkflow } from "./fixtures/budgets.application.js";

class First {
  readonly id = 1;
}
class Second {
  readonly id = 2;
}
class NotABudget {
  readonly id = 3;
}

const handler = { maxSpend: (): Usd => usd(1) };

@Budget({ name: "tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
class TenantBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}
@Budget({ name: "application-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
class ApplicationBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}
@Budget({ name: "default-budget", scope: BudgetScope.Execution })
class DefaultBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}
@Budget({ name: "other-default-budget", scope: BudgetScope.Execution })
class OtherDefaultBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}
@Budget({ name: "first-budget", scope: BudgetScope.Execution, workflow: First })
class FirstBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}
@Budget({ name: "other-first-budget", scope: BudgetScope.Execution, workflow: First })
class OtherFirstBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}
@Budget({ name: "brief-budget", scope: BudgetScope.Execution, workflow: BriefWorkflow })
class BriefBudget {
  maxSpend(): Usd {
    return handler.maxSpend();
  }
}

const violationsOf = (workflows: readonly Class[], budgets?: readonly Class[]) =>
  budgetRuleViolations({
    name: "shop",
    workflows,
    tenantContext: Object,
    ...(budgets === undefined ? {} : { budgets }),
  }).map(({ code, message, nodes }) => ({ code, message, nodes }));

const REQUIRED = [TenantBudget, ApplicationBudget];

describe("#1356: the rules of an application's budgets", () => {
  it("an application with every cap has no violation", () => {
    expect(violationsOf([First], [...REQUIRED, FirstBudget])).toEqual([]);
    expect(violationsOf([First, Second], [...REQUIRED, DefaultBudget])).toEqual([]);
  });

  it("an application with no budgets at all lacks every cap", () => {
    expect(violationsOf([First]).map((each) => each.code)).toEqual([
      "budget.execution-budget-required",
      "budget.tenant-budget-required",
      "budget.application-budget-required",
    ]);
    expect(violationsOf([First], []).map((each) => each.code)).toEqual(
      violationsOf([First]).map((each) => each.code),
    );
  });

  it("a class that is not a budget is no budget", () => {
    expect(violationsOf([First], [NotABudget, ...REQUIRED, FirstBudget])).toEqual([]);
    expect(violationsOf([First], [NotABudget]).map((each) => each.code)).toContain(
      "budget.tenant-budget-required",
    );
  });

  it("names the workflow by its declared name, else by its class, and every violation points at the application", () => {
    expect(violationsOf([BriefWorkflow, First], REQUIRED)).toEqual([
      {
        code: "budget.execution-budget-required",
        message:
          "brief-workflow has no execution budget and there is no default — set budget: on its @Workflow, add one with workflow: BriefWorkflow or one without workflow",
        nodes: ["shop"],
      },
      {
        code: "budget.execution-budget-required",
        message:
          "First has no execution budget and there is no default — set budget: on its @Workflow, add one with workflow: First or one without workflow",
        nodes: ["shop"],
      },
    ]);
  });

  it("without a default, only the workflows with no budget of their own are uncovered", () => {
    expect(violationsOf([First, Second], [...REQUIRED, FirstBudget])).toEqual([
      expect.objectContaining({
        code: "budget.execution-budget-required",
        message: expect.stringContaining("Second has no execution budget"),
      }),
    ]);
  });

  it("a default budget covers every workflow, one with a budget of its own as well", () => {
    expect(violationsOf([First, Second], [...REQUIRED, DefaultBudget, FirstBudget])).toEqual([]);
  });

  it("two own budgets of one workflow are a duplicate, named with the declared name of it", () => {
    expect(violationsOf([First], [...REQUIRED, FirstBudget, OtherFirstBudget])).toEqual([
      {
        code: "budget.duplicate-execution-budget",
        message:
          "First has 2 execution budgets (first-budget, other-first-budget) — keep one with workflow: First",
        nodes: ["shop"],
      },
    ]);
    expect(violationsOf([BriefWorkflow], [...REQUIRED, BriefBudget, BriefBudget])).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("brief-workflow has 2 execution budgets"),
      }),
    ]);
  });

  it("one own budget for each of two workflows is no duplicate", () => {
    expect(violationsOf([First, Second], [...REQUIRED, FirstBudget, BriefBudget])).toEqual([
      expect.objectContaining({ code: "budget.execution-budget-required" }),
    ]);
  });

  it("two defaults are a duplicate", () => {
    expect(violationsOf([First], [...REQUIRED, DefaultBudget, OtherDefaultBudget])).toEqual([
      {
        code: "budget.duplicate-default-execution-budget",
        message:
          "shop has 2 default execution budgets (default-budget, other-default-budget) — keep one without workflow",
        nodes: ["shop"],
      },
    ]);
  });

  it("a tenant budget is not an application budget, nor the other way round", () => {
    expect(violationsOf([First], [FirstBudget, TenantBudget])).toEqual([
      {
        code: "budget.application-budget-required",
        message:
          "shop has no application budget — add a @Budget({ scope: BudgetScope.Application, period }) to its budgets",
        nodes: ["shop"],
      },
    ]);
    expect(violationsOf([First], [FirstBudget, ApplicationBudget])).toEqual([
      {
        code: "budget.tenant-budget-required",
        message:
          "shop has no tenant budget — add a @Budget({ scope: BudgetScope.Tenant, period }) to its budgets",
        nodes: ["shop"],
      },
    ]);
  });

  it("an execution budget is neither of them", () => {
    expect(violationsOf([First], [FirstBudget, DefaultBudget]).map((each) => each.code)).toEqual([
      "budget.tenant-budget-required",
      "budget.application-budget-required",
    ]);
  });
});

describe("#1356: the periods of a budget", () => {
  it("name the period by its words", () => {
    expect(periodWords(BudgetPeriod.Day)).toBe("today");
    expect(periodWords(BudgetPeriod.Week)).toBe("this week");
    expect(periodWords(BudgetPeriod.Month)).toBe("this month");
  });

  it("a week starts on Monday, a month on its first day, a day is itself (UTC)", () => {
    const sunday = new Date("2026-10-18T23:59:59.999Z");
    expect(periodStartOf(BudgetPeriod.Day, sunday)).toBe("2026-10-18");
    expect(periodStartOf(BudgetPeriod.Week, sunday)).toBe("2026-10-12");
    expect(periodStartOf(BudgetPeriod.Week, new Date("2026-10-12T00:00:00.000Z"))).toBe(
      "2026-10-12",
    );
    expect(periodStartOf(BudgetPeriod.Week, new Date("2026-10-19T00:00:00.000Z"))).toBe(
      "2026-10-19",
    );
    expect(periodStartOf(BudgetPeriod.Month, sunday)).toBe("2026-10-01");
  });
});
