/**
 * #1356 (spend shard) — the rules of an application's budgets that the attached budgets and the limits add, each on its
 * own with the exact message: where a budget limits something and says it in one place only (#1318), which budgets an
 * application has when workflows attach them, which execution budget caps a workflow, and when a workflow is covered.
 */
import { describe, expect, it } from "vitest";
import { Budget, BudgetPeriod, BudgetScope, budgetOf } from "../../src/budgets/budget.js";
import {
  attachedBudgetsOf,
  budgetRuleViolations,
  budgetsOfApplication,
  executionBudgetFor,
} from "../../src/budgets/budget-rules.js";
import { BudgetOverlays } from "../../src/budgets/budget-overlay.js";
import type { Class } from "../../src/components/injection.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { Ttl, usd } from "../../src/units/index.js";

@Budget({
  name: "tenant-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  maxSpend: usd(1),
})
class TenantBudget {}
@Budget({
  name: "shop-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
  maxSpend: usd(1),
})
class ShopBudget {}
@Budget({ name: "default-budget", scope: BudgetScope.Execution, maxSpend: usd(1) })
class DefaultBudget {}
@Budget({ name: "own-budget", scope: BudgetScope.Execution, maxSpend: usd(1) })
class OwnBudget {}
@Budget({ name: "swap-budget", scope: BudgetScope.Execution, maxSpend: usd(1) })
class SwapBudget {}
@Budget({ name: "tier-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day, maxTokens: 10 })
class TierBudget {}
@Budget({ name: "both-budget", scope: BudgetScope.Execution, maxSpend: usd(1) })
class BothBudget {
  limit() {
    return { maxSpend: usd(2) };
  }
}
@Budget({ name: "capped-budget", scope: BudgetScope.Execution, maxTokens: 5 })
class CappedBudget {
  maxSpend() {
    return usd(1);
  }
}
@Budget({ name: "nothing-budget", scope: BudgetScope.Execution })
class NothingBudget {}
@Budget({ name: "coded-budget", scope: BudgetScope.Execution })
class CodedBudget {
  limit() {
    return { maxSpend: usd(1) };
  }
}

const workflowOf = (name: string, budget?: Class): Class => {
  @Workflow({
    name,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [],
    ...(budget ? { budget } : {}),
  })
  class Declared {}
  return Declared;
};

const app = (workflows: Class[], budgets: Class[], extra: object = {}) =>
  ({ name: "shop", workflows, budgets, tenantContext: Object, ...extra }) as never;
const caps = [TenantBudget, ShopBudget];
const messages = (violations: ReturnType<typeof budgetRuleViolations>) =>
  violations.map(({ code, message, nodes }) => ({ code, message, nodes }));

describe("#1356: a budget limits something, in one place", () => {
  it("one that declares its limits and also has limit() or maxSpend() is a conflict, named", () => {
    const found = budgetRuleViolations(
      app([workflowOf("w")], [...caps, DefaultBudget, BothBudget, CappedBudget]),
    );

    expect(messages(found)).toEqual([
      {
        code: "budget.duplicate-default-execution-budget",
        message:
          "shop has 3 default execution budgets (default-budget, both-budget, capped-budget) — keep one without workflow",
        nodes: ["shop"],
      },
      {
        code: "budget.conflicting-limit",
        message:
          "both-budget declares maxSpend / maxTokens and also has limit() — keep one of them",
        nodes: ["shop"],
      },
      {
        code: "budget.conflicting-limit",
        message:
          "capped-budget declares maxSpend / maxTokens and also has limit() — keep one of them",
        nodes: ["shop"],
      },
    ]);
  });

  it("one that limits nothing is named; one that reads limit() alone, or declares alone, is fine", () => {
    const found = budgetRuleViolations(app([workflowOf("w")], [...caps, NothingBudget]));
    const fine = budgetRuleViolations(app([workflowOf("w")], [...caps, CodedBudget]));

    expect(messages(found)).toEqual([
      {
        code: "budget.missing-limit",
        message:
          "nothing-budget limits nothing — declare maxSpend and/or maxTokens in @Budget, or write limit()",
        nodes: ["shop"],
      },
    ]);
    expect(fine).toEqual([]);
  });

  it("a class that is no budget has no limit to check", () => {
    class NotABudget {
      readonly kind = "none";
    }

    expect(
      budgetRuleViolations(app([workflowOf("w")], [...caps, DefaultBudget, NotABudget])),
    ).toEqual([]);
  });
});

describe("#1356: the budgets of an application when workflows attach them", () => {
  it("are the listed ones, then each attached one once, a listed class staying as listed", () => {
    const a = workflowOf("a", TierBudget);
    const b = workflowOf("b", TierBudget);
    const c = workflowOf("c", OwnBudget);
    const plain = workflowOf("plain");

    expect(budgetsOfApplication({ budgets: [DefaultBudget], workflows: [a, b, c, plain] })).toEqual(
      [DefaultBudget, TierBudget, OwnBudget],
    );
    expect(budgetsOfApplication({ budgets: [TierBudget, TierBudget], workflows: [a] })).toEqual([
      TierBudget,
      TierBudget,
    ]);
    expect(budgetsOfApplication({})).toEqual([]);
    expect(attachedBudgetsOf({ workflows: [a, b, c, plain] })).toEqual([TierBudget, OwnBudget]);
    expect(attachedBudgetsOf({})).toEqual([]);
  });

  it("a profile's budget for a workflow is the one it attaches, in place of the declared one", () => {
    const a = workflowOf("a", TierBudget);
    const overlays = new BudgetOverlays([], new Map([[a, SwapBudget]]));

    expect(attachedBudgetsOf({ workflows: [a], budgetOverlays: overlays })).toEqual([SwapBudget]);
    expect(budgetsOfApplication({ workflows: [a], budgetOverlays: overlays })).toEqual([
      SwapBudget,
    ]);
  });

  it("a limit a profile gives a budget is on the class that is listed", () => {
    const overlays = new BudgetOverlays([["default-budget", { maxSpend: usd(9) }]], new Map());

    const listed = budgetsOfApplication({ budgets: [DefaultBudget], budgetOverlays: overlays });

    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toBe(DefaultBudget);
    expect(listed.map((cls) => budgetOf(cls)?.maxSpend)).toEqual([9]);
  });
});

describe("#1356: the execution budget that caps a workflow", () => {
  const metaOf = (...classes: Class[]) =>
    classes.map((cls) => budgetOf(cls)).filter((meta) => meta !== undefined);
  const W = workflowOf("w");

  it("its own: the execution budget a workflow attaches", () => {
    const attaches = workflowOf("attaches", OwnBudget);
    const metas = metaOf(DefaultBudget, OwnBudget, TierBudget);

    expect(executionBudgetFor(metas, attaches)).toMatchObject({
      meta: { name: "own-budget" },
      isOwn: true,
    });
  });

  it("a workflow that names itself in a budget has it as its own", () => {
    const named = workflowOf("named-flow");
    @Budget({
      name: "named-flow-budget",
      scope: BudgetScope.Execution,
      maxSpend: usd(1),
      workflow: named,
    })
    class NamedFlowBudget {}

    expect(executionBudgetFor(metaOf(DefaultBudget, NamedFlowBudget), named)).toMatchObject({
      meta: { name: "named-flow-budget" },
      isOwn: true,
    });
  });

  it("a tenant budget a workflow attaches is no execution budget of its own: the default caps it", () => {
    const tiered = workflowOf("tiered", TierBudget);

    expect(executionBudgetFor(metaOf(DefaultBudget, TierBudget), tiered)).toMatchObject({
      meta: { name: "default-budget" },
      isOwn: false,
    });
  });

  it("the default is the first with no workflow that no workflow attaches; none when none is left", () => {
    expect(executionBudgetFor(metaOf(OwnBudget, DefaultBudget), W, [OwnBudget])).toMatchObject({
      meta: { name: "default-budget" },
      isOwn: false,
    });
    expect(executionBudgetFor(metaOf(OwnBudget), W, [OwnBudget])).toBeUndefined();
    expect(executionBudgetFor(metaOf(OwnBudget, DefaultBudget), W)).toMatchObject({
      meta: { name: "own-budget" },
    });
    expect(executionBudgetFor([], W)).toBeUndefined();
  });

  it("a profile's budget for the workflow is the one it is capped by", () => {
    const a = workflowOf("a", TierBudget);
    const overlays = new BudgetOverlays([], new Map([[a, SwapBudget]]));

    expect(executionBudgetFor(metaOf(DefaultBudget, SwapBudget), a, [], overlays)).toMatchObject({
      meta: { name: "swap-budget" },
      isOwn: true,
    });
  });

  it("a limit a profile gives the attached budget is the one the workflow is capped by", () => {
    const a = workflowOf("a", OwnBudget);
    const overlays = new BudgetOverlays([["own-budget", { maxSpend: usd(9) }]], new Map());

    const found = executionBudgetFor(metaOf(DefaultBudget), a, [], overlays);

    expect(found).toMatchObject({ meta: { name: "own-budget", maxSpend: 9 }, isOwn: true });
  });
});

describe("#1356: when a workflow is covered", () => {
  const metaOf = (...classes: Class[]) =>
    classes.map((cls) => budgetOf(cls)).filter((meta) => meta !== undefined);

  it("one that attaches an execution budget needs no default, and the budget it attaches is no default for another", () => {
    const attaches = workflowOf("attaches", OwnBudget);
    const bare = workflowOf("bare");

    const covered = budgetRuleViolations(app([attaches], [...caps, OwnBudget]));
    const bareOne = budgetRuleViolations(app([attaches, bare], [...caps, OwnBudget]));

    expect(covered).toEqual([]);
    expect(messages(bareOne)).toEqual([
      {
        code: "budget.execution-budget-required",
        message:
          "bare has no execution budget and there is no default — set budget: on its @Workflow, add one with workflow: Declared or one without workflow",
        nodes: ["shop"],
      },
    ]);
  });

  it("a tenant budget a workflow attaches covers nothing of the execution: it still needs a default", () => {
    const tiered = workflowOf("tiered", TierBudget);

    expect(budgetRuleViolations(app([tiered], [ShopBudget])).map((v) => v.code)).toEqual([
      "budget.execution-budget-required",
    ]);
    expect(budgetRuleViolations(app([tiered], [ShopBudget, DefaultBudget]))).toEqual([]);
  });

  it("a budget that a profile attaches in place of a workflow's own is its own too", () => {
    const a = workflowOf("a", TierBudget);
    const overlays = new BudgetOverlays([], new Map([[a, SwapBudget]]));

    expect(budgetRuleViolations(app([a], [...caps], { budgetOverlays: overlays }))).toEqual([]);
  });

  it("an application with no tenant context needs no tenant budget", () => {
    const found = budgetRuleViolations(
      app([workflowOf("w")], [ShopBudget, DefaultBudget], { tenantContext: undefined }),
    );

    expect(found).toEqual([]);
  });

  it("a budget of another scope that names the workflow is no execution budget of it, and no default", () => {
    const named = workflowOf("named-flow");
    @Budget({
      name: "tenant-of-named",
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Day,
      maxSpend: usd(1),
      workflow: named,
    } as never)
    class TenantOfNamed {}

    expect(executionBudgetFor(metaOf(TenantOfNamed, DefaultBudget), named)).toMatchObject({
      meta: { name: "default-budget" },
      isOwn: false,
    });
    expect(executionBudgetFor(metaOf(TenantOfNamed), named)).toBeUndefined();
  });

  it("an execution budget that names another workflow is the default of none", () => {
    const other = workflowOf("other-flow");
    @Budget({
      name: "other-budget",
      scope: BudgetScope.Execution,
      maxSpend: usd(1),
      workflow: other,
    })
    class OtherFlowBudget {}

    expect(executionBudgetFor(metaOf(OtherFlowBudget), workflowOf("w"))).toBeUndefined();
  });

  it("classes some workflow attaches that are no budget count for nothing", () => {
    class NotABudget {
      readonly kind = "none";
    }

    expect(
      executionBudgetFor(metaOf(DefaultBudget), workflowOf("w"), [NotABudget, OwnBudget]),
    ).toMatchObject({
      meta: { name: "default-budget" },
    });
  });

  it("a workflow that attaches a class that is no budget is no one's attached budget, and breaks no rule of its own", () => {
    class NotABudget {
      readonly kind = "none";
    }
    const odd = workflowOf("odd", NotABudget);

    expect(budgetRuleViolations(app([odd], [...caps, DefaultBudget]))).toEqual([]);
  });
});
