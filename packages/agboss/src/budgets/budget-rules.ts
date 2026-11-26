import { ComponentKind } from "../flow/runtime/records.js";
import type { Class } from "../components/injection.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { violation, type RuleCode, type RuleViolation } from "../graph/rule-error.js";
import { budgetOf, BudgetScope, type BudgetMeta } from "./budget.js";
import { overlaidBudget, type OverlaidBudgets } from "./budget-overlay.js";

/**
 * The rules of an application's budgets (#261 AC10), read from its declaration: every workflow is
 * covered by its own execution budget (`workflow: X`, at most one) or by the one default execution
 * budget (no `workflow`), and there is at least one tenant budget and one application budget — so
 * no execution ever runs without a cap on its cost, its tenant's and the application's.
 */

/** What the rules read of an application. */
export interface BudgetedApplication extends OverlaidBudgets {
  readonly name: string;
  readonly workflows: readonly Class[];
  readonly budgets?: readonly Class[] | undefined;
  /** `@Application({ tenantContext })`: without one every execution is of one tenant and needs no tenant budget. */
  readonly tenantContext?: Class | undefined;
}

/** The `@Budget` class a workflow attaches with `@Workflow({ budget })`, if it does. */
export const attachedBudgetOf = (
  workflow: Class,
  overlays?: OverlaidBudgets["budgetOverlays"],
): Class | undefined => {
  const slot = overlays?.slots.get(workflow);
  if (slot !== undefined) return slot;
  const declaration = declarationOf(workflow);
  return declaration?.kind === ComponentKind.Workflow ? declaration.options.budget : undefined;
};

/**
 * Every budget of an application (#1318): the ones it lists and the ones its workflows attach with
 * `@Workflow({ budget })` — found without being listed —, each once.
 */
export const budgetsOfApplication = (
  application: {
    readonly workflows?: readonly Class[] | undefined;
    readonly budgets?: readonly Class[] | undefined;
  } & OverlaidBudgets,
): readonly Class[] => {
  const overlays = application.budgetOverlays;
  const listed = (application.budgets ?? []).map((budget) => overlaidBudget(budget, overlays));
  const attached = (application.workflows ?? []).flatMap((workflow) => {
    const budget = attachedBudgetOf(workflow, overlays);
    return budget === undefined ? [] : [overlaidBudget(budget, overlays)];
  });
  // a listed class stays as listed (a class listed twice is still a duplicate); an attached one once
  return [...listed, ...new Set(attached.filter((budget) => !listed.includes(budget)))];
};

/** The budget classes some workflow of the application attaches with `@Workflow({ budget })`, each once. */
export const attachedBudgetsOf = (
  application: {
    readonly workflows?: readonly Class[] | undefined;
  } & OverlaidBudgets,
): readonly Class[] => [
  ...new Set(
    (application.workflows ?? []).flatMap((workflow) => {
      const budget = attachedBudgetOf(workflow, application.budgetOverlays);
      return budget === undefined ? [] : [overlaidBudget(budget, application.budgetOverlays)];
    }),
  ),
];

/**
 * The execution budget that caps `workflow` among `metas`: the one it attaches or names with
 * `workflow: X` (its own), else the default (no `workflow`, attached by no workflow).
 */
export function executionBudgetFor(
  metas: readonly BudgetMeta[],
  workflow: Class,
  attachedByAny: readonly Class[] = [],
  budgetOverlays?: OverlaidBudgets["budgetOverlays"],
): { readonly meta: BudgetMeta; readonly isOwn: boolean } | undefined {
  const execution = metas.filter((meta) => meta.scope === BudgetScope.Execution);
  const attachedClass = attachedBudgetOf(workflow, budgetOverlays);
  const attached =
    attachedClass === undefined ? undefined : overlaidBudget(attachedClass, budgetOverlays);
  const attachedMeta = attached === undefined ? undefined : budgetOf(attached);
  const own =
    attachedMeta?.scope === BudgetScope.Execution
      ? attachedMeta
      : execution.find((meta) => meta.workflow === workflow);
  if (own !== undefined) return { meta: own, isOwn: true };
  const others = new Set(attachedByAny.flatMap((cls) => budgetOf(cls)?.name ?? []));
  const fallback = execution.find((meta) => meta.workflow === undefined && !others.has(meta.name));
  return fallback === undefined ? undefined : { meta: fallback, isOwn: false };
}

/** The `name` of a `@Workflow` class, else the class's own. */
const workflowNameOf = (workflow: Class): string => {
  const declaration = declarationOf(workflow);
  return declaration?.kind === ComponentKind.Workflow ? declaration.options.name : workflow.name;
};

const declared = (budgets: readonly Class[]): readonly BudgetMeta[] =>
  budgets.map(budgetOf).filter((meta) => meta !== undefined);

/** `[budget.duplicate-execution-budget]`: two own execution budgets for one workflow. */
function duplicateOwn(application: string, execution: readonly BudgetMeta[]): RuleViolation[] {
  const byWorkflow = new Map<Class, BudgetMeta[]>();
  for (const meta of execution) {
    if (meta.workflow === undefined) continue;
    byWorkflow.set(meta.workflow, [...(byWorkflow.get(meta.workflow) ?? []), meta]);
  }
  return [...byWorkflow].flatMap(([workflow, metas]) =>
    metas.length < 2
      ? []
      : [
          violation(
            "budget.duplicate-execution-budget",
            `${workflowNameOf(workflow)} has ${String(metas.length)} execution budgets (${metas.map((meta) => meta.name).join(", ")}) — keep one with workflow: ${workflow.name}`,
            [application],
          ),
        ],
  );
}

/** `[budget.duplicate-default-execution-budget]`: two execution budgets without `workflow`. */
function duplicateDefault(application: string, defaults: readonly BudgetMeta[]): RuleViolation[] {
  if (defaults.length < 2) return [];
  return [
    violation(
      "budget.duplicate-default-execution-budget",
      `${application} has ${String(defaults.length)} default execution budgets (${defaults.map((meta) => meta.name).join(", ")}) — keep one without workflow`,
      [application],
    ),
  ];
}

/** Whether `workflow` has its own execution budget: one with `workflow: X`, or one it attaches. */
const isCovered = (
  workflow: Class,
  execution: readonly BudgetMeta[],
  overlays: OverlaidBudgets["budgetOverlays"],
): boolean => {
  const attached = attachedBudgetOf(workflow, overlays);
  const attachedMeta = attached === undefined ? undefined : budgetOf(attached);
  return (
    attachedMeta?.scope === BudgetScope.Execution ||
    execution.some((meta) => meta.workflow === workflow)
  );
};

/** `[budget.execution-budget-required]`: a workflow covered by neither its own budget nor a default. */
function uncovered(
  application: BudgetedApplication,
  execution: readonly BudgetMeta[],
): RuleViolation[] {
  if (execution.some((meta) => meta.workflow === undefined && !isAttached(meta, application)))
    return [];
  return application.workflows
    .filter((workflow) => !isCovered(workflow, execution, application.budgetOverlays))
    .map((workflow) => {
      const name = workflowNameOf(workflow);
      return violation(
        "budget.execution-budget-required",
        `${name} has no execution budget and there is no default — set budget: on its @Workflow, add one with workflow: ${workflow.name} or one without workflow`,
        [application.name],
      );
    });
}

/** Whether `meta` is a budget some workflow of `application` attaches (it is then that workflow's own, not a default). */
const isAttached = (meta: BudgetMeta, application: BudgetedApplication): boolean =>
  application.workflows.some((workflow) => {
    const attached = attachedBudgetOf(workflow, application.budgetOverlays);
    return attached !== undefined && budgetOf(attached)?.name === meta.name;
  });

/** The class prototype's method named `name`, when it has one. */
const hasMethod = (cls: Class, name: string): boolean =>
  typeof (cls.prototype as Record<string, unknown>)[name] === "function";

/**
 * `[budget.missing-limit]` / `[budget.conflicting-limit]` (#1318): a budget limits something — a
 * `maxSpend` or a `maxTokens` in `@Budget`, or a `limit()` — and says it in one place only.
 */
function limitViolations(application: string, budgets: readonly Class[]): RuleViolation[] {
  return budgets.flatMap((cls) => {
    const meta = budgetOf(cls);
    if (meta === undefined) return [];
    const declared = meta.maxSpend !== undefined || meta.maxTokens !== undefined;
    const coded = hasMethod(cls, "limit") || hasMethod(cls, "maxSpend");
    if (declared && coded)
      return [
        violation(
          "budget.conflicting-limit",
          `${meta.name} declares maxSpend / maxTokens and also has limit() — keep one of them`,
          [application],
        ),
      ];
    if (!declared && !coded)
      return [
        violation(
          "budget.missing-limit",
          `${meta.name} limits nothing — declare maxSpend and/or maxTokens in @Budget, or write limit()`,
          [application],
        ),
      ];
    return [];
  });
}

/** `[budget.tenant-budget-required]` / `[budget.application-budget-required]`. */
function scopeRequired(
  application: string,
  metas: readonly BudgetMeta[],
  scope: BudgetScope.Tenant | BudgetScope.Application,
): RuleViolation[] {
  if (metas.some((meta) => meta.scope === scope)) return [];
  const isTenant = scope === BudgetScope.Tenant;
  const code: RuleCode = isTenant
    ? "budget.tenant-budget-required"
    : "budget.application-budget-required";
  const what = isTenant ? "tenant" : "application";
  const member = isTenant ? "Tenant" : "Application";
  return [
    violation(
      code,
      `${application} has no ${what} budget — add a @Budget({ scope: BudgetScope.${member}, period }) to its budgets`,
      [application],
    ),
  ];
}

export function budgetRuleViolations(application: BudgetedApplication): RuleViolation[] {
  const budgets = budgetsOfApplication(application);
  const metas = declared(budgets);
  const execution = metas.filter((meta) => meta.scope === BudgetScope.Execution);
  const defaults = execution.filter(
    (meta) => meta.workflow === undefined && !isAttached(meta, application),
  );
  return [
    ...uncovered(application, execution),
    ...duplicateOwn(application.name, execution),
    ...duplicateDefault(application.name, defaults),
    ...limitViolations(application.name, budgets),
    ...(application.tenantContext === undefined
      ? []
      : scopeRequired(application.name, metas, BudgetScope.Tenant)),
    ...scopeRequired(application.name, metas, BudgetScope.Application),
  ];
}
