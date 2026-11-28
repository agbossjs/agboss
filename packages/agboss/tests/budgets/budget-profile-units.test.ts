/**
 * #1356 (spend shard) — what a profile changes of the budgets, rule by rule: the limits it gives by budget name (a dollar
 * cap as `Usd`), the `@Budget` it attaches to a workflow in place of its own, the names it gets wrong said with the
 * profiles' names and what the application has, a budget that reads its limits in code that takes none.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { budgetOverlaysOf } from "../../src/application/budget-profile.js";
import { Budget, BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { BudgetOverlays } from "../../src/budgets/budget-overlay.js";
import type { Class } from "../../src/components/injection.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { slotsOf } from "../../src/config/workflow-overlay.js";
import { withChildWorkflows } from "../../src/flow/analyse/child-workflow.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { Ttl, usd } from "../../src/units/index.js";

vi.mock("../../src/config/workflow-overlay.js", () => ({ slotsOf: vi.fn(() => ({})) }));
vi.mock("../../src/flow/analyse/child-workflow.js", () => ({
  withChildWorkflows: vi.fn((workflows: readonly Class[]) => workflows),
}));

@Budget({
  name: "tier-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  maxSpend: usd(3),
})
class TierBudget {}

@Budget({
  name: "token-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  maxTokens: 500,
})
class TokenBudget {}

@Budget({ name: "coded-budget", scope: BudgetScope.Application, period: BudgetPeriod.Day })
class CodedBudget {
  limit() {
    return { maxSpend: usd(1) };
  }
}

@Budget({ name: "slotted-budget", scope: BudgetScope.Execution, maxSpend: usd(2) })
class SlottedBudget {}

const workflowOf = (name: string): Class => {
  @Workflow({ name, version: "1.0.0", historyTtl: Ttl.Forever, flow: [] })
  class Declared {}
  return Declared;
};

const folded = (budgets: Record<string, object>, profiles: string[] = ["prod"]) =>
  ({ budgets, profiles, env: [] }) as never;
const optionsOf = (budgets: Class[], workflows: Class[] = []) => ({ budgets, workflows }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(slotsOf).mockImplementation(() => ({}));
  vi.mocked(withChildWorkflows).mockImplementation((workflows) => workflows);
});

const failure = (make: () => unknown): ProfileError => {
  try {
    make();
  } catch (error) {
    return error as ProfileError;
  }
  throw new Error("no failure");
};

describe("#1356: what a profile changes of the budgets", () => {
  it("nothing when no profile gives a limit or a budget to a workflow", () => {
    expect(
      budgetOverlaysOf(folded({}), optionsOf([TierBudget], [workflowOf("plain")])),
    ).toBeUndefined();
  });

  it("the limits by budget name, a dollar cap as dollars and a token cap as it is, in the order given", () => {
    const overlays = budgetOverlaysOf(
      folded({ "tier-budget": { maxSpend: 5 }, "token-budget": { maxTokens: 900 } }),
      optionsOf([TierBudget, TokenBudget]),
    );

    expect(overlays).toBeInstanceOf(BudgetOverlays);
    expect([...(overlays?.entries() ?? [])]).toStrictEqual([
      ["tier-budget", { maxSpend: usd(5) }],
      ["token-budget", { maxTokens: 900 }],
    ]);
    expect(overlays?.slots.size).toBe(0);
  });

  it("a dollar cap from a profile is checked as dollars: one below zero is refused", () => {
    expect(() =>
      budgetOverlaysOf(folded({ "tier-budget": { maxSpend: -1 } }), optionsOf([TierBudget])),
    ).toThrow(/usd/);
  });

  it("a limit given as an env reference is kept as it is", () => {
    const ref = { name: "TIER_CAP" };

    const overlays = budgetOverlaysOf(
      folded({ "tier-budget": { maxSpend: ref } }),
      optionsOf([TierBudget]),
    );

    expect(overlays?.get("tier-budget")).toStrictEqual({ maxSpend: ref });
  });

  it("the budget a profile attaches to a workflow, and the budgets of the child workflows a workflow runs are asked too", () => {
    const child = workflowOf("child-flow");
    const parent = workflowOf("parent-flow");
    const plain = workflowOf("plain-flow");
    vi.mocked(withChildWorkflows).mockImplementation((workflows) => [...workflows, child]);
    vi.mocked(slotsOf).mockImplementation((_folded: unknown, name: string) =>
      name === "child-flow" ? { budget: SlottedBudget } : {},
    );

    const overlays = budgetOverlaysOf(folded({}), optionsOf([TierBudget], [parent, plain]));

    expect([...(overlays?.slots ?? [])]).toStrictEqual([[child, SlottedBudget]]);
    expect(overlays?.size).toBe(0);
    expect(vi.mocked(slotsOf).mock.calls.map(([, name]) => name)).toEqual([
      "parent-flow",
      "plain-flow",
      "child-flow",
    ]);
    expect(withChildWorkflows).toHaveBeenCalledWith([parent, plain]);
  });

  it("a limit for a budget a slot brings is a limit of the application's budgets", () => {
    const wf = workflowOf("slotted-flow");
    vi.mocked(slotsOf).mockImplementation((_folded: unknown, name: string) =>
      name === "slotted-flow" ? { budget: SlottedBudget } : {},
    );

    const overlays = budgetOverlaysOf(
      folded({ "slotted-budget": { maxSpend: 9 } }),
      optionsOf([], [wf]),
    );

    expect(overlays?.get("slotted-budget")).toStrictEqual({ maxSpend: usd(9) });
  });

  it("a name that is no budget of the application is ProfileError.Unknown naming the profiles and what the application has", () => {
    vi.mocked(slotsOf).mockImplementation(() => ({}));

    const error = failure(() =>
      budgetOverlaysOf(
        folded({ "ghost-budget": { maxSpend: 1 } }, ["base", "prod"]),
        optionsOf([TierBudget, TokenBudget]),
      ),
    );

    expect(error).toBeInstanceOf(ProfileError);
    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toBe(
      "profile base,prod: budgets.ghost-budget: no such budget in the application — it has: tier-budget, token-budget",
    );
  });

  it("an application with no budget says it has none", () => {
    const error = failure(() =>
      budgetOverlaysOf(folded({ "ghost-budget": { maxSpend: 1 } }), optionsOf([])),
    );

    expect(error.message).toBe(
      "profile prod: budgets.ghost-budget: no such budget in the application — it has: none",
    );
  });

  it("a budget that reads its limits in code takes none: ProfileError.Invalid says to declare them in @Budget", () => {
    const error = failure(() =>
      budgetOverlaysOf(folded({ "coded-budget": { maxSpend: 1 } }), optionsOf([CodedBudget])),
    );

    expect(error.reason).toBe(ProfileErrorReason.Invalid);
    expect(error.message).toBe(
      "profile prod: budgets.coded-budget: coded-budget reads its limits in limit(), a profile cannot set them — declare maxSpend / maxTokens in its @Budget",
    );
  });

  it("a budget that declares only a token cap, or only a dollar cap, takes limits", () => {
    expect(() =>
      budgetOverlaysOf(folded({ "token-budget": { maxTokens: 1 } }), optionsOf([TokenBudget])),
    ).not.toThrow();
    expect(() =>
      budgetOverlaysOf(folded({ "tier-budget": { maxSpend: 1 } }), optionsOf([TierBudget])),
    ).not.toThrow();
  });

  it("a workflow of the application that no @Workflow declares, or that is some other component, is asked for no budget", () => {
    class Undeclared {
      readonly kind = "undeclared";
    }
    const plain = workflowOf("plain-flow");
    vi.mocked(slotsOf).mockImplementation(() => ({ budget: SlottedBudget }));

    const overlays = budgetOverlaysOf(folded({}), optionsOf([], [Undeclared, plain]));

    expect([...(overlays?.slots ?? [])]).toStrictEqual([[plain, SlottedBudget]]);
    expect(vi.mocked(slotsOf).mock.calls.map(([, name]) => name)).toEqual(["plain-flow"]);
  });

  it("a class listed among the budgets that is no @Budget is no budget the application has", () => {
    class NotABudget {
      readonly kind = "none";
    }

    const error = failure(() =>
      budgetOverlaysOf(
        folded({ "ghost-budget": { maxSpend: 1 } }),
        optionsOf([TierBudget, NotABudget]),
      ),
    );

    expect(error.message).toBe(
      "profile prod: budgets.ghost-budget: no such budget in the application — it has: tier-budget",
    );
  });
});
