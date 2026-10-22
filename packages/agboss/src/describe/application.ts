import type { AssembledApplication } from "../application/assemble.js";
import {
  implementationLine,
  implementationsOf,
  ImplementationReason,
  type ImplementationChoice,
} from "../application/implementations.js";
import { assemblyWarningsOf, warningText, type AssemblyWarning } from "../application/start-log.js";
import { budgetOf, BudgetScope, type BudgetMeta } from "../budgets/budget.js";
import type { Class } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import { isModelProviderClass, modelProviderOf } from "../models/model-provider.decorator.js";
import { modelProvidersOf } from "../models/resolution.js";

/**
 * What `agboss describe` says about an application as a whole (#261, #268 AC4): its infrastructure —
 * each contract's implementation and why — its model providers and why, its budgets by scope (with
 * their periods) and the execution budget that covers each workflow, its observers and its assembly
 * warnings. Read from the decorators only: no budget amount (`maxSpend()` runs only inside an
 * execution).
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
  /** The workflow it caps. */
  readonly workflow: string;
  /** The budget's name; absent when no execution budget covers it (assembly rejects that). */
  readonly name?: string;
  readonly isOwn: boolean;
}

/** One model provider of the application and why it is used. */
export interface DescribedModelProvider {
  readonly name: string;
  readonly className: string;
  readonly reason: ImplementationReason;
  /** `serves`, each pattern as written. */
  readonly serves: readonly string[];
}

/** An application, as `describe` shows it. */
export interface DescribedApplication {
  readonly name: string;
  readonly version: string;
  /** Every workflow it runs: the listed ones, then the children they launch. */
  readonly workflows: readonly string[];
  readonly implementations: readonly ImplementationChoice[];
  readonly modelProviders: readonly DescribedModelProvider[];
  readonly budgets: readonly DescribedBudget[];
  readonly executionBudgets: readonly DescribedExecutionBudget[];
  readonly observers: readonly string[];
  readonly warnings: readonly string[];
  /** `@Application({ maxConcurrentSteps })` (#332): the instance's cap on steps; absent = none. */
  readonly maxConcurrentSteps?: number;
}

const describedBudget = (
  meta: BudgetMeta,
  nameOf: (workflow: Class) => string,
): DescribedBudget => ({
  name: meta.name,
  scope: meta.scope,
  ...(meta.period === undefined ? {} : { period: meta.period }),
  ...(meta.workflow === undefined ? {} : { workflow: nameOf(meta.workflow) }),
});

/** The workflow's own execution budget, else the default (no `workflow`). */
function executionBudgetOf(
  budgets: readonly BudgetMeta[],
  workflow: Class,
  name: string,
): DescribedExecutionBudget {
  const execution = budgets.filter((budget) => budget.scope === BudgetScope.Execution);
  const own = execution.find((budget) => budget.workflow === workflow);
  if (own !== undefined) return { workflow: name, name: own.name, isOwn: true };
  const fallback = execution.find((budget) => budget.workflow === undefined);
  return fallback === undefined
    ? { workflow: name, isOwn: false }
    : { workflow: name, name: fallback.name, isOwn: false };
}

/** The application's model providers: the listed ones, else the built-ins (#266). */
function modelProvidersOfApplication(
  assembled: AssembledApplication,
): readonly DescribedModelProvider[] {
  const isListed = assembled.providers.some(isModelProviderClass);
  return modelProvidersOf(assembled.providers).map((provider) => {
    const options = modelProviderOf(provider);
    return {
      name: options.name,
      className: provider.name,
      reason: isListed ? ImplementationReason.Listed : ImplementationReason.Default,
      serves: options.serves.map(String),
    };
  });
}

/**
 * The assembly warnings of an application (`agboss check`, errors under `--strict`): its budgets on
 * an in-memory ledger, its pauses in memory, PII tokens on a key of the instance (no
 * `pseudonymKey`, #120 S94).
 */
export const applicationWarningsOf = (
  assembled: AssembledApplication,
): readonly AssemblyWarning[] =>
  assemblyWarningsOf({ ...assembled, isPiiKeyOfInstance: assembled.pseudonymKey === undefined });

/** The application, described from its assembly. */
export function describedApplicationOf(assembled: AssembledApplication): DescribedApplication {
  const names = new Map<Class, string>(
    assembled.workflows.map((workflow) => [workflow.graph.type, workflow.config.name]),
  );
  const nameOf = (workflow: Class): string => names.get(workflow) ?? workflow.name;
  const budgets = assembled.budgets.flatMap((budget) => budgetOf(budget) ?? []);
  return {
    name: assembled.name,
    version: assembled.version,
    workflows: assembled.workflows.map((workflow) => workflow.config.name),
    implementations: implementationsOf(assembled.providers),
    modelProviders: modelProvidersOfApplication(assembled),
    budgets: budgets.map((meta) => describedBudget(meta, nameOf)),
    executionBudgets: assembled.workflows.map((workflow) =>
      executionBudgetOf(budgets, workflow.graph.type, workflow.config.name),
    ),
    observers: assembled.observers.map(tokenName),
    warnings: applicationWarningsOf(assembled).map(warningText),
    ...(assembled.maxConcurrentSteps === undefined
      ? {}
      : { maxConcurrentSteps: assembled.maxConcurrentSteps }),
  };
}

/** `maxConcurrentSteps 32 (set) · …`, or that the instance has no cap (#332). */
const stepCapLine = (described: DescribedApplication): string =>
  described.maxConcurrentSteps === undefined
    ? "maxConcurrentSteps none (not set) · no cap on this instance's steps"
    : `maxConcurrentSteps ${String(described.maxConcurrentSteps)} (set) · agent, router and action steps of this instance at work at once`;

const SCOPES: readonly BudgetScope[] = [
  BudgetScope.Application,
  BudgetScope.Tenant,
  BudgetScope.Execution,
];

/** `tenant-daily-budget (day)`, `screening-execution-budget (screening-workflow)`, `x (default)`. */
const budgetLabel = (budget: DescribedBudget): string =>
  `${budget.name} (${budget.period ?? budget.workflow ?? "default"})`;

/** `screening-workflow: x (its own) — applies when it is the root of app.execute; …`. */
function executionBudgetLine(budget: DescribedExecutionBudget): string {
  if (budget.name === undefined) return `  ${budget.workflow}: no execution budget`;
  const whose = budget.isOwn ? "its own" : "the default";
  return `  ${budget.workflow}: ${budget.name} (${whose}) — applies when it is the root of app.execute; nested, it spends from its root's`;
}

/** The budgets by scope, then the one that caps each workflow. */
function budgetLines(described: DescribedApplication): string[] {
  const byScope = SCOPES.flatMap((scope) => {
    const listed = described.budgets.filter((budget) => budget.scope === scope);
    return listed.length === 0 ? [] : [`  ${scope}: ${listed.map(budgetLabel).join(", ")}`];
  });
  return ["budgets", ...byScope, ...described.executionBudgets.map(executionBudgetLine)];
}

/** `openrouter-model-provider → OpenRouterModelProvider (listed in @Application providers) · serves …`. */
const modelProviderLine = (provider: DescribedModelProvider): string =>
  `  ${provider.name} → ${provider.className} (${
    provider.reason === ImplementationReason.Listed
      ? "listed in @Application providers"
      : "built-in default: none listed"
  }) · serves ${provider.serves.join(", ")}`;

/** The application's implementations, model providers, budgets, observers and warnings. */
export function applicationLines(described: DescribedApplication): string[] {
  return [
    "implementations",
    ...described.implementations.map((choice) => `  ${implementationLine(choice)}`),
    "model providers",
    ...described.modelProviders.map(modelProviderLine),
    ...budgetLines(described),
    `observers ${described.observers.join(", ") || "none"}`,
    stepCapLine(described),
    ...described.warnings.map((warning) => `warning ${warning}`),
  ];
}
