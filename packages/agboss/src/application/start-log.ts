import { BaseCheckpointSaver } from "@langchain/langgraph";
import { budgetOf, BudgetScope } from "../budgets/budget.js";
import type { Class, Provider } from "../components/injection.js";
import { channelUsesOf } from "../channels/discovery.js";
import { worstCaseLine } from "../flow/analyse/worst-case.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import { CostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { ExecutionHistoryRepository } from "../infrastructure/execution-history.repository.js";
import { ChildExecutionQueueRepository } from "../infrastructure/child-execution-queue.repository.js";
import { launchesOnAnyInstance } from "../flow/analyse/child-placements.js";
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
  /**
   * Whether PII tokens are made with a key of the instance (#120 S94): an instance knows it from its
   * start; `agboss check` from `@Application({ pseudonymKey })` not being set.
   */
  readonly isPiiKeyOfInstance?: boolean;
  /** `@Application({ executionRecordRetention })` (#401): root executions are kept when it is set. */
  readonly executionRecordRetention?: number | undefined;
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

const IN_MEMORY_EXECUTION_HISTORY: AssemblyWarning = {
  code: "application.in-memory-execution-history",
  message:
    "in-memory execution history: executionRecordRetention keeps each instance's executions in its own memory — another instance and agboss records export do not see them, and they are lost on restart",
};

const IN_MEMORY_CHILD_QUEUE: AssemblyWarning = {
  code: "application.in-memory-child-queue",
  message:
    "in-memory child queue: children launched with placement: ChildPlacement.AnyInstance run only on the instance that launched them — list SqliteChildExecutionQueueRepository (or your own ChildExecutionQueueRepository) so any instance claims them",
};

const PII_INSTANCE_KEY: AssemblyWarning = {
  code: "application.pii-instance-key",
  message:
    "no @Application({ pseudonymKey }): sensitive fields make PII tokens with a key of each execution — one value gets another token in each execution (in logs and traces: on each instance), so tokens compare across executions only with pseudonymKey",
};

/** Whether a tenant or an application budget is listed (counted across executions). */
const hasPeriodBudget = (budgets: readonly Provider[]): boolean =>
  budgets.some((budget) => {
    const scope = typeof budget === "function" ? budgetOf(budget)?.scope : undefined;
    return scope === BudgetScope.Tenant || scope === BudgetScope.Application;
  });

/** Whether an execution may pause: a workflow with a channel (an approval) pauses at it. */
const canPause = (workflows: readonly AssembledWorkflow[]): boolean =>
  workflows.some((workflow) => channelUsesOf([workflow.graph.type]).length > 0);

/** Whether a workflow launches a child on any instance (#333 PR 2). */
const launchesAnywhere = (workflows: readonly AssembledWorkflow[]): boolean =>
  workflows.some((workflow) => launchesOnAnyInstance(workflow.graph.nodes.values()));

/**
 * The assembly warnings (#261): tenant or application budgets on an in-memory ledger; possible
 * pauses with in-memory paused executions or checkpoints; children on any instance on an in-memory
 * queue (#333 PR 2); PII tokens on a key of the instance (#120).
 */
export function assemblyWarningsOf(sources: WarningSources): readonly AssemblyWarning[] {
  const choices = implementationsOf(sources.providers);
  const inMemory = (contract: Class): boolean => isInMemory(choices, contract);
  const found: readonly (readonly [boolean, AssemblyWarning])[] = [
    [hasPeriodBudget(sources.budgets) && inMemory(CostLedgerRepository), IN_MEMORY_LEDGER],
    [
      canPause(sources.workflows) &&
        (inMemory(PausedExecutionRepository) || inMemory(BaseCheckpointSaver)),
      IN_MEMORY_PAUSES,
    ],
    [
      sources.executionRecordRetention !== undefined && inMemory(ExecutionHistoryRepository),
      IN_MEMORY_EXECUTION_HISTORY,
    ],
    [
      launchesAnywhere(sources.workflows) && inMemory(ChildExecutionQueueRepository),
      IN_MEMORY_CHILD_QUEUE,
    ],
    [sources.isPiiKeyOfInstance === true, PII_INSTANCE_KEY],
  ];
  return found.flatMap(([applies, warning]) => (applies ? [warning] : []));
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
