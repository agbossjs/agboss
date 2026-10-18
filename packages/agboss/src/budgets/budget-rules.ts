import type { Class } from "../components/injection.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { violation, type RuleCode, type RuleViolation } from "../graph/rule-error.js";
import { budgetOf, BudgetScope, type BudgetMeta } from "./budget.js";

/**
 * The rules of an application's budgets (#261 AC10), read from its declaration: every workflow is
 * covered by its own execution budget (`workflow: X`, at most one) or by the one default execution
 * budget (no `workflow`), and there is at least one tenant budget and one application budget — so
 * no execution ever runs without a cap on its cost, its tenant's and the application's.
 */

/** What the rules read of an application. */
export interface BudgetedApplication {
  readonly name: string;
  readonly workflows: readonly Class[];
  readonly budgets?: readonly Class[] | undefined;
}

/** The `name` of a `@Workflow` class, else the class's own. */
const workflowNameOf = (workflow: Class): string => {
  const declaration = declarationOf(workflow);
  return declaration?.kind === NodeKind.Workflow ? declaration.options.name : workflow.name;
};

const declared = (budgets: readonly Class[]): readonly BudgetMeta[] =>
  budgets.flatMap((budget) => {
    const meta = budgetOf(budget);
    return meta === undefined ? [] : [meta];
  });

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

/** `[budget.execution-budget-required]`: a workflow covered by neither its own budget nor a default. */
function uncovered(
  application: BudgetedApplication,
  execution: readonly BudgetMeta[],
): RuleViolation[] {
  if (execution.some((meta) => meta.workflow === undefined)) return [];
  return application.workflows
    .filter((workflow) => !execution.some((meta) => meta.workflow === workflow))
    .map((workflow) => {
      const name = workflowNameOf(workflow);
      return violation(
        "budget.execution-budget-required",
        `${name} has no execution budget and there is no default — add one with workflow: ${workflow.name} or one without workflow`,
        [application.name],
      );
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
  const metas = declared(application.budgets ?? []);
  const execution = metas.filter((meta) => meta.scope === BudgetScope.Execution);
  const defaults = execution.filter((meta) => meta.workflow === undefined);
  return [
    ...uncovered(application, execution),
    ...duplicateOwn(application.name, execution),
    ...duplicateDefault(application.name, defaults),
    ...scopeRequired(application.name, metas, BudgetScope.Tenant),
    ...scopeRequired(application.name, metas, BudgetScope.Application),
  ];
}
