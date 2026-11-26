import { ComponentKind } from "../flow/runtime/records.js";
import type { Class } from "../components/injection.js";
import { budgetOf } from "../budgets/budget.js";
import { budgetsOfApplication } from "../budgets/budget-rules.js";
import { BudgetOverlays, type BudgetOverlay } from "../budgets/budget-overlay.js";
import type { FoldedConfig } from "../config/fold-config.js";
import { ProfileError, ProfileErrorReason } from "../config/profile-error.js";
import { slotsOf } from "../config/workflow-overlay.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { usd } from "../units/index.js";
import type { ApplicationOptions } from "./application.js";

/** A YAML limit is a number: the branded dollars a budget takes. */
const limitOf = (overlay: BudgetOverlay): BudgetOverlay => ({
  ...overlay,
  ...(typeof overlay.maxSpend === "number" ? { maxSpend: usd(overlay.maxSpend) } : {}),
});

/** The `@Budget` each workflow gets from a profile in place of its own, by workflow class. */
function budgetSlotsOf(folded: FoldedConfig, options: ApplicationOptions): Map<Class, Class> {
  const slots = new Map<Class, Class>();
  for (const workflow of withChildWorkflows(options.workflows)) {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== ComponentKind.Workflow) continue;
    const { budget } = slotsOf(folded, declaration.options.name);
    if (budget !== undefined) slots.set(workflow, budget);
  }
  return slots;
}

/**
 * What the profiles change of the budgets: the limits they give, by budget name, and the `budget` they
 * attach to a workflow. Every limit name is a budget of the application (listed or attached, a slot's
 * included), and a budget that reads its limits in `limit()` takes none — a profile cannot make it
 * declare them. `undefined` when no profile changes a budget.
 */
export function budgetOverlaysOf(
  folded: FoldedConfig,
  options: ApplicationOptions,
): BudgetOverlays | undefined {
  const named = Object.entries(folded.budgets);
  const slots = budgetSlotsOf(folded, options);
  if (named.length === 0 && slots.size === 0) return undefined;
  const slotted = new BudgetOverlays([], slots);
  const metas = budgetsOfApplication({
    budgets: options.budgets,
    workflows: withChildWorkflows(options.workflows),
    budgetOverlays: slotted,
  }).flatMap((cls) => budgetOf(cls) ?? []);
  const profiles = folded.profiles.join(",");
  for (const [name] of named) {
    const meta = metas.find((one) => one.name === name);
    if (meta === undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Unknown,
        message: `profile ${profiles}: budgets.${name}: no such budget in the application — it has: ${metas.map((one) => one.name).join(", ") || "none"}`,
      });
    if (meta.maxSpend === undefined && meta.maxTokens === undefined)
      throw new ProfileError({
        reason: ProfileErrorReason.Invalid,
        message: `profile ${profiles}: budgets.${name}: ${name} reads its limits in limit(), a profile cannot set them — declare maxSpend / maxTokens in its @Budget`,
      });
  }
  return new BudgetOverlays(
    named.map(([name, overlay]) => [name, limitOf(overlay)] as const),
    slots,
  );
}
