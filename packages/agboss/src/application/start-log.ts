import { BaseCheckpointSaver } from "@langchain/langgraph";
import { budgetOf, BudgetScope } from "../budgets/budget.js";
import type { Class, Provider } from "../components/injection.js";
import { moduleOf } from "../components/module.js";
import { worstCaseLine } from "../flow/analyse/worst-case.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import { CostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { AssembledWorkflow } from "../workflow.js";
import { implementationsOf, isInMemory } from "./implementations.js";

/**
 * What an application instance logs at start, once (#261): only what the decorators say — no
 * project code is called, so no budget amount (`maxSpend()` runs only inside an execution) and
 * nothing per tenant. Two kinds of lines: what started, and the worst case of one call of each
 * start in counts; then the startup warnings. Tests (`testWith`) log none of it.
 */

/** A warning about how the application is assembled: errors under `agboss check --strict`. */
export interface AssemblyWarning {
  readonly code: string;
  readonly message: string;
}

/** What the warnings are read from: the application's providers, budgets and workflows. */
export interface WarningSources {
  readonly providers: readonly Provider[];
  readonly budgets: readonly Provider[];
  readonly workflows: readonly AssembledWorkflow[];
}

const IN_MEMORY_LEDGER: AssemblyWarning = {
  code: "application.in-memory-cost-ledger",
  message:
    "in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart",
};

const IN_MEMORY_PAUSES: AssemblyWarning = {
  code: "application.in-memory-pauses",
  message:
    "in-memory pauses: another application instance cannot resume them and they are lost on restart",
};

/** Whether a tenant or an application budget is listed (counted across executions). */
const hasPeriodBudget = (budgets: readonly Provider[]): boolean =>
  budgets.some((budget) => {
    const scope = typeof budget === "function" ? budgetOf(budget)?.scope : undefined;
    return scope === BudgetScope.Tenant || scope === BudgetScope.Application;
  });

/** Whether an execution may pause: a workflow with a channel (an approval) pauses at it. */
const canPause = (workflows: readonly AssembledWorkflow[]): boolean =>
  workflows.some((workflow) => (moduleOf(workflow.graph.type).channelClasses ?? []).length > 0);

/**
 * The assembly warnings (#261): tenant or application budgets on an in-memory ledger; possible
 * pauses with in-memory paused executions or checkpoints.
 */
export function assemblyWarningsOf(sources: WarningSources): readonly AssemblyWarning[] {
  const choices = implementationsOf(sources.providers);
  const inMemory = (contract: Class): boolean => isInMemory(choices, contract);
  return [
    ...(hasPeriodBudget(sources.budgets) && inMemory(CostLedgerRepository)
      ? [IN_MEMORY_LEDGER]
      : []),
    ...(canPause(sources.workflows) &&
    (inMemory(PausedExecutionRepository) || inMemory(BaseCheckpointSaver))
      ? [IN_MEMORY_PAUSES]
      : []),
  ];
}

/** `[application.in-memory-pauses] in-memory pauses: …` — a warning as `app.warnings` lists it. */
export const warningText = (warning: AssemblyWarning): string =>
  `[${warning.code}] ${warning.message}`;

/** `Started job-scout-application 1.0.0 — environment prod, host scout-7f3a, process 41237`. */
export function startedLine(application: ApplicationContext): string {
  const { name, version, environmentName, host } = application;
  const where = [
    `environment ${environmentName}`,
    ...(host.hostname === "" ? [] : [`host ${host.hostname}`]),
    `process ${String(host.pid)}`,
  ];
  return `Started ${name} ${version} — ${where.join(", ")}`;
}

/** The start log of an instance: what started, each start's worst case, then each warning. */
export function logStart(
  log: FrameworkLog,
  application: ApplicationContext,
  workflows: readonly AssembledWorkflow[],
  warnings: readonly string[],
): void {
  log.info("app.started", startedLine(application));
  for (const workflow of workflows) {
    for (const worst of workflow.graph.analysis.worstCases) {
      log.info("app.worst-case", worstCaseLine(worst));
    }
  }
  for (const warning of warnings) log.warn("app.warning", warning);
}
