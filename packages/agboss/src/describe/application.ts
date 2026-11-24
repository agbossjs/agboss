import {
  attachedBudgetsOf,
  budgetsOfApplication,
  executionBudgetFor,
} from "../budgets/budget-rules.js";
import { calendarNameOf } from "../calendar/calendar-source.js";
import { requireApplication } from "../application/application.js";
import type { AssembledApplication } from "../application/assemble.js";
import {
  implementationLine,
  implementationsOf,
  ImplementationReason,
  type ImplementationChoice,
} from "../application/implementations.js";
import {
  storageLinesOf,
  storageProvidersOf,
  type StorageLine,
} from "../storage/storage-assembly.js";
import { assemblyWarningsOf, warningText, type AssemblyWarning } from "../application/start-log.js";
import { budgetOf, BudgetScope, type BudgetMeta } from "../budgets/budget.js";
import type { Class } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import { modelProvidersOfApplication, type DescribedModelProvider } from "./model-providers.js";
import { listenersOf, pauseListenerOf } from "../pause/pause-listener.js";

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
  /** What the budget is for (`@Budget({ description })`). */
  readonly description?: string;
}

/** The execution budget that caps one workflow, and whether it is the workflow's own. */
export interface DescribedExecutionBudget {
  /** The workflow it caps. */
  readonly workflow: string;
  /** The budget's name; absent when no execution budget covers it (assembly rejects that). */
  readonly name?: string;
  readonly isOwn: boolean;
}

/** One listed `@PauseListener`: its name, and whether it is trusted with the ids of channel pauses. */
export interface DescribedPauseListener {
  readonly name: string;
  readonly allowAnswering: boolean;
}

/** An application, as `describe` shows it. */
export interface DescribedApplication {
  readonly name: string;
  readonly version: string;
  /** Every workflow it runs: the listed ones, then the children they launch. */
  readonly workflows: readonly string[];
  readonly implementations: readonly ImplementationChoice[];
  /** `@Application({ storage })` (#1321): each storage component with its driver; absent = none declared. */
  readonly storage?: readonly StorageLine[];
  readonly modelProviders: readonly DescribedModelProvider[];
  readonly budgets: readonly DescribedBudget[];
  readonly executionBudgets: readonly DescribedExecutionBudget[];
  readonly observers: readonly string[];
  /** Its `@PauseListener`s (#940): each pause of the application is told to every one. */
  readonly pauseListeners: readonly DescribedPauseListener[];
  readonly warnings: readonly string[];
  /** The name of its default calendar for working time (#944): `working-week` or its `@WorkingCalendar`'s; absent = none. */
  readonly workingCalendar?: string;
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
  ...(meta.description === undefined ? {} : { description: meta.description }),
});

/** The workflow's own execution budget (attached or `workflow: X`), else the default (no `workflow`). */
function executionBudgetOf(
  budgets: readonly BudgetMeta[],
  workflow: Class,
  name: string,
  attachedByAny: readonly Class[],
): DescribedExecutionBudget {
  const found = executionBudgetFor(budgets, workflow, attachedByAny);
  return found === undefined
    ? { workflow: name, isOwn: false }
    : { workflow: name, name: found.meta.name, isOwn: found.isOwn };
}

/**
 * The assembly warnings of an application (`agboss check`, errors under `--strict`): its budgets on
 * an in-memory ledger, its pauses in memory.
 */
export const applicationWarningsOf = (
  assembled: AssembledApplication,
): readonly AssemblyWarning[] => assemblyWarningsOf(assembled);

/** The application, described from its assembly. */
export function describedApplicationOf(assembled: AssembledApplication): DescribedApplication {
  const names = new Map<Class, string>(
    assembled.workflows.map((workflow) => [workflow.graph.type, workflow.config.name]),
  );
  const nameOf = (workflow: Class): string => names.get(workflow) ?? workflow.name;
  const budgets = budgetsOfApplication({
    budgets: assembled.budgets,
    workflows: assembled.workflows.map((workflow) => workflow.graph.type),
    budgetOverlays: assembled.budgetOverlays,
  }).flatMap((budget) => budgetOf(budget) ?? []);
  return {
    name: assembled.name,
    version: assembled.version,
    workflows: assembled.workflows.map((workflow) => workflow.config.name),
    implementations: implementationsOf(
      assembled.providers,
      assembled.storage === undefined ? undefined : storageProvidersOf(assembled.storage).owned,
    ),
    ...(assembled.storage === undefined ? {} : { storage: storageLinesOf(assembled.storage) }),
    modelProviders: modelProvidersOfApplication(assembled),
    budgets: budgets.map((meta) => describedBudget(meta, nameOf)),
    executionBudgets: assembled.workflows.map((workflow) =>
      executionBudgetOf(
        budgets,
        workflow.graph.type,
        workflow.config.name,
        attachedBudgetsOf({
          workflows: assembled.workflows.map((one) => one.graph.type),
          budgetOverlays: assembled.budgetOverlays,
        }),
      ),
    ),
    observers: assembled.observers.map(tokenName),
    pauseListeners: listenersOf(assembled.providers).flatMap((cls) => {
      const meta = pauseListenerOf(cls);
      return meta === undefined ? [] : [{ name: meta.name, allowAnswering: meta.allowAnswering }];
    }),
    warnings: applicationWarningsOf(assembled).map(warningText),
    ...calendarFieldOf(assembled.application),
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
      : provider.isNamed
        ? "named by modelProvider"
        : "built-in default: none listed"
  })${provider.serves.length === 0 ? "" : ` · serves ${provider.serves.join(", ")}`}${
    provider.isTransport ? ` · transport: ${provider.className}.complete()` : ""
  }`;

/** `pause listeners ledger-pause-listener (allowAnswering: sees the ids of channel pauses), …`. */
const pauseListenerLines = (described: DescribedApplication): string[] =>
  described.pauseListeners.length === 0
    ? []
    : [
        `pause listeners ${described.pauseListeners
          .map(
            ({ name, allowAnswering }) =>
              `${name}${allowAnswering ? " (allowAnswering: sees the ids of channel pauses)" : ""}`,
          )
          .join(", ")}`,
      ];

/** The application's implementations, model providers, budgets, observers and warnings. */
export function applicationLines(described: DescribedApplication): string[] {
  return [
    ...(described.storage === undefined
      ? []
      : [
          "storage",
          // `describes` already names the backend (`sqlite (AGBOSS_SQLITE_PATH)`)
          ...described.storage.map((line) => `  ${line.role}: ${line.name} → ${line.describes}`),
        ]),
    "implementations",
    ...described.implementations.map((choice) => `  ${implementationLine(choice)}`),
    "model providers",
    ...described.modelProviders.map(modelProviderLine),
    ...budgetLines(described),
    `observers ${described.observers.join(", ") || "none"}`,
    ...pauseListenerLines(described),
    stepCapLine(described),
    ...described.warnings.map((warning) => `warning ${warning}`),
  ];
}

/** `{ workingCalendar: name }` of the application's default calendar; nothing without one (#944). */
function calendarFieldOf(application: Class): { readonly workingCalendar?: string } {
  const source = requireApplication(application, "describe").options.workingCalendar;
  return source === undefined ? {} : { workingCalendar: calendarNameOf(source) };
}
