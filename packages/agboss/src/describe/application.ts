import { applicationOfWorkflow } from "../application/workflow-application.js";
import type { ApplicationOptions } from "../application/application.js";
import {
  implementationLine,
  implementationsOf,
  type ImplementationChoice,
} from "../application/implementations.js";
import { assemblyWarningsOf, warningText, type AssemblyWarning } from "../application/start-log.js";
import { budgetOf, BudgetScope, type BudgetMeta } from "../budgets/budget.js";
import type { Class } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { NodeKind } from "../flow/ast.js";
import type { AssembledWorkflow } from "../workflow.js";

/**
 * What `agboss describe` says about a workflow's application (#261): its infrastructure — each
 * contract's implementation and why — its budgets by scope (with their periods), the execution
 * budget that covers this workflow, its observers and its assembly warnings. Read from the
 * decorators only: no budget amount (`maxSpend()` runs only inside an execution).
 */

/** One listed budget: its name, scope, period, and the workflow of an execution budget. */
export interface DescribedBudget {
  readonly name: string;
  readonly scope: BudgetScope;
  readonly period?: string;
  /** The workflow's name, for its own execution budget; absent for the default one. */
  readonly workflow?: string;
}

/** The execution budget that caps one workflow, and whether it is the workflow's own. */
export interface DescribedExecutionBudget {
  readonly name: string;
  readonly isOwn: boolean;
}

/** A workflow's application, as `describe` shows it. */
export interface DescribedApplication {
  readonly name: string;
  readonly version: string;
  readonly workflows: readonly string[];
  readonly implementations: readonly ImplementationChoice[];
  readonly budgets: readonly DescribedBudget[];
  readonly executionBudget: DescribedExecutionBudget | undefined;
  readonly observers: readonly string[];
  readonly warnings: readonly string[];
}

const nameOfWorkflow = (workflow: Class): string => {
  const options: unknown = declarationOf(workflow)?.options;
  return typeof options === "object" && options !== null && "name" in options
    ? String(options.name)
    : workflow.name;
};

const describedBudget = (meta: BudgetMeta): DescribedBudget => ({
  name: meta.name,
  scope: meta.scope,
  ...(meta.period === undefined ? {} : { period: meta.period }),
  ...(meta.workflow === undefined ? {} : { workflow: nameOfWorkflow(meta.workflow) }),
});

const budgetsOf = (options: ApplicationOptions): readonly BudgetMeta[] =>
  (options.budgets ?? []).flatMap((budget) => budgetOf(budget) ?? []);

/** The workflow's own execution budget, else the default (no `workflow`). */
function executionBudgetOf(
  budgets: readonly BudgetMeta[],
  workflow: Class,
): DescribedExecutionBudget | undefined {
  const execution = budgets.filter((budget) => budget.scope === BudgetScope.Execution);
  const own = execution.find((budget) => budget.workflow === workflow);
  if (own !== undefined) return { name: own.name, isOwn: true };
  const fallback = execution.find((budget) => budget.workflow === undefined);
  return fallback === undefined ? undefined : { name: fallback.name, isOwn: false };
}

/**
 * The assembly warnings of the workflow in its application (`agboss check`, errors under
 * `--strict`): its budgets on an in-memory ledger, its pauses in memory. None on its own.
 */
export function applicationWarningsOf(bundle: AssembledWorkflow): readonly AssemblyWarning[] {
  const declaration = applicationOfWorkflow(bundle.graph.type);
  if (declaration === undefined) return [];
  const { options } = declaration;
  return assemblyWarningsOf({
    providers: options.providers ?? [],
    budgets: options.budgets ?? [],
    workflows: [bundle],
  });
}

/** The application that lists the workflow, described; `undefined` for a workflow on its own. */
export function describedApplicationOf(
  bundle: AssembledWorkflow,
): DescribedApplication | undefined {
  const declaration = applicationOfWorkflow(bundle.graph.type);
  if (declaration === undefined) return undefined;
  const { options } = declaration;
  const budgets = budgetsOf(options);
  const workflows = options.workflows.filter(
    (workflow) => declarationOf(workflow)?.kind === NodeKind.Workflow,
  );
  return {
    name: options.name,
    version: options.version,
    workflows: workflows.map(nameOfWorkflow),
    implementations: implementationsOf(options.providers ?? []),
    budgets: budgets.map(describedBudget),
    executionBudget: executionBudgetOf(budgets, bundle.graph.type),
    observers: (options.observers ?? []).map(tokenName),
    warnings: applicationWarningsOf(bundle).map(warningText),
  };
}

const SCOPES: readonly BudgetScope[] = [
  BudgetScope.Application,
  BudgetScope.Tenant,
  BudgetScope.Execution,
];

/** `tenant-daily-budget (day)`, `screening-execution-budget (screening-workflow)`, `x (default)`. */
const budgetLabel = (budget: DescribedBudget): string =>
  `${budget.name} (${budget.period ?? budget.workflow ?? "default"})`;

/** The budgets by scope, then the one that caps this workflow. */
function budgetLines(described: DescribedApplication, workflow: string): string[] {
  const byScope = SCOPES.flatMap((scope) => {
    const listed = described.budgets.filter((budget) => budget.scope === scope);
    return listed.length === 0 ? [] : [`  ${scope}: ${listed.map(budgetLabel).join(", ")}`];
  });
  const capped = described.executionBudget;
  const cap =
    capped === undefined
      ? `  ${workflow}: no execution budget`
      : `  ${workflow}: ${capped.name} (${capped.isOwn ? "its own" : "the default"}) — applies when it is the root of app.execute; nested, it spends from its root's`;
  return ["budgets", ...byScope, cap];
}

/** The application section of `describe`'s text; empty for a workflow on its own. */
export function applicationLines(bundle: AssembledWorkflow): string[] {
  const described = describedApplicationOf(bundle);
  if (described === undefined) return [];
  return [
    `application ${described.name} ${described.version} · workflows ${described.workflows.join(", ")}`,
    "implementations",
    ...described.implementations.map((choice) => `  ${implementationLine(choice)}`),
    ...budgetLines(described, bundle.config.name),
    `observers ${described.observers.join(", ") || "none"}`,
    ...described.warnings.map((warning) => `warning ${warning}`),
  ];
}
