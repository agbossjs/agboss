/**
 * #1356 (spend shard) — the budget as the selected profiles leave it, rule by rule: the class itself when no profile names
 * it, else a subclass of it whose `@Budget` record carries the overlaid limits, made once per class and overlay, never
 * overlaid again, the declared class and its record left as they were.
 */
import { describe, expect, it } from "vitest";
import { recordedOptionsOf } from "../../src/components/option-keys.js";
import { Budget, BudgetPeriod, BudgetScope, budgetOf } from "../../src/budgets/budget.js";
import { BudgetOverlays, overlaidBudget } from "../../src/budgets/budget-overlay.js";
import type { Class } from "../../src/components/injection.js";
import { usd } from "../../src/units/index.js";

@Budget({
  name: "tier-budget",
  scope: BudgetScope.Tenant,
  period: BudgetPeriod.Day,
  maxSpend: usd(3),
  maxTokens: 100,
})
class TierBudget {}

@Budget({
  name: "other-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
  maxSpend: usd(1),
})
class OtherBudget {}

class NoBudget {
  readonly kind = "none";
}

const overlaysOf = (limits: [string, object][], slots: [Class, Class][] = []) =>
  new BudgetOverlays(limits as never, new Map(slots));

describe("#1356: the budgets as profiles leave them", () => {
  it("a profile's limits are a map by budget name that carries its slots", () => {
    const slot = new Map<Class, Class>([[NoBudget, TierBudget]]);
    const overlays = new BudgetOverlays([["tier-budget", { maxSpend: usd(5) }]], slot);

    expect(overlays).toBeInstanceOf(Map);
    expect(overlays.get("tier-budget")).toStrictEqual({ maxSpend: usd(5) });
    expect(overlays.slots).toBe(slot);
  });

  it("a class no profile names, or one that is no budget, or no profile at all, is the class itself", () => {
    const overlays = overlaysOf([["other-budget", { maxSpend: usd(9) }]]);

    expect(overlaidBudget(TierBudget, overlays)).toBe(TierBudget);
    expect(overlaidBudget(TierBudget, undefined)).toBe(TierBudget);
    expect(overlaidBudget(NoBudget, overlays)).toBe(NoBudget);
    expect(overlaidBudget(NoBudget, undefined)).toBe(NoBudget);
  });

  it("a class a profile names is a subclass of it, by the same name, whose record is the declared one over which the limits lie", () => {
    const overlay = { maxSpend: usd(7) };

    const derived = overlaidBudget(TierBudget, overlaysOf([["tier-budget", overlay]]));

    expect(derived).not.toBe(TierBudget);
    expect(derived.prototype).toBeInstanceOf(TierBudget);
    expect(derived.name).toBe("TierBudget");
    expect(budgetOf(derived)).toStrictEqual({
      deps: [],
      name: "tier-budget",
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Day,
      maxSpend: usd(7),
      maxTokens: 100,
    });
  });

  it("the declared class and its record are never changed: two applications under two profiles never see each other's limits", () => {
    const one = overlaidBudget(TierBudget, overlaysOf([["tier-budget", { maxSpend: usd(7) }]]));
    const two = overlaidBudget(TierBudget, overlaysOf([["tier-budget", { maxTokens: 5 }]]));

    expect(budgetOf(TierBudget)).toMatchObject({ maxSpend: usd(3), maxTokens: 100 });
    expect(budgetOf(one)).toMatchObject({ maxSpend: usd(7), maxTokens: 100 });
    expect(budgetOf(two)).toMatchObject({ maxSpend: usd(3), maxTokens: 5 });
    expect(one).not.toBe(two);
  });

  it("the same class and the same overlay always give the same derived class, so a list that holds it twice holds one", () => {
    const overlay = { maxSpend: usd(7) };
    const overlays = overlaysOf([["tier-budget", overlay]]);

    const first = overlaidBudget(TierBudget, overlays);

    expect(overlaidBudget(TierBudget, overlays)).toBe(first);
    expect(overlaidBudget(TierBudget, overlaysOf([["tier-budget", overlay]]))).toBe(first);
    expect(new Set([first, overlaidBudget(TierBudget, overlays)]).size).toBe(1);
  });

  it("a class this module derived is never overlaid again, whatever the overlays say", () => {
    const overlays = overlaysOf([["tier-budget", { maxSpend: usd(7) }]]);
    const derived = overlaidBudget(TierBudget, overlays);

    const again = overlaidBudget(derived, overlaysOf([["tier-budget", { maxSpend: usd(99) }]]));

    expect(again).toBe(derived);
    expect(budgetOf(again)?.maxSpend).toBe(7);
  });

  it("an overlay of another budget's name leaves a budget alone, and each budget gets its own", () => {
    const overlays = overlaysOf([
      ["tier-budget", { maxSpend: usd(7) }],
      ["other-budget", { maxSpend: usd(8) }],
    ]);

    expect(budgetOf(overlaidBudget(TierBudget, overlays))?.maxSpend).toBe(7);
    expect(budgetOf(overlaidBudget(OtherBudget, overlays))?.maxSpend).toBe(8);
  });
});

describe("#1356: what @Budget records", () => {
  @Budget({
    name: "described-budget",
    scope: BudgetScope.Execution,
    description: "caps one run",
    maxSpend: usd(1),
  })
  class Described {}

  @Budget({ name: "bare-budget", scope: BudgetScope.Execution, maxTokens: 5 })
  class Bare {}

  it("its description with the rest of its record, and no key for one that is not given", () => {
    expect(budgetOf(Described)).toStrictEqual({
      name: "described-budget",
      scope: BudgetScope.Execution,
      deps: [],
      description: "caps one run",
      maxSpend: usd(1),
    });
    expect(budgetOf(Bare)).toStrictEqual({
      name: "bare-budget",
      scope: BudgetScope.Execution,
      deps: [],
      maxTokens: 5,
    });
  });

  it("its options are recorded under the decorator's name, for the check of keys that are not its own", () => {
    expect(recordedOptionsOf(Described).map((one) => one.decorator)).toEqual(["Budget"]);
    expect(recordedOptionsOf(Described)[0]?.unknown).toEqual([]);
  });
});
