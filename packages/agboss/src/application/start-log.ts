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
import { componentOf } from "../components/metadata.js";
import { hasSensitiveFields } from "../dto/redact.js";
import type { DtoClass } from "../dto/types.js";
import { NodeKind } from "../flow/ast.js";
import { implementationsOf, isInMemory, notAtomicStoresOf } from "./implementations.js";
import { inlineFilesWarningOf } from "../a2a/a2a-file-store-rule.js";
import type { A2AFileOptions } from "../a2a/files/a2a-file-options.js";
import { a2aCardWarningsOf } from "../a2a/a2a-card-warnings.js";
import type { ProviderModule } from "../components/container/registrations.js";

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
   * start; `agboss check` from `@Application({ piiKeyField })` not being set.
   */
  readonly isPiiKeyOfInstance?: boolean;
  /** `@Application({ retention: { executionRecords } })` (#401): root executions are kept when it is set. */
  readonly executionRecordRetention?: number | undefined;
  /** The application's own PII policies (#644: a policy makes tokens, so the key matters). */
  readonly piiPolicies?: readonly Class[];
  /** Its declared contexts: a `sensitive` field of theirs makes tokens too (#644). */
  readonly tenantContext?: Class;
  readonly executionContext?: Class;
  /** The application's name, exposes and `a2aFiles` (#859): where its A2A files ride. */
  readonly name?: string;
  readonly exposes?: readonly Class[];
  readonly a2aFiles?: A2AFileOptions | undefined;
  /** The application's own and its workflows' providers (#812: where an `@A2AAgent` is listed). */
  readonly modules?: readonly ProviderModule[];
}

const IN_MEMORY_LEDGER: AssemblyWarning = {
  code: "application.in-memory-cost-ledger",
  message:
    "in-memory cost ledger: each application instance counts budgets on its own and the counters reset on restart",
};

/**
 * `[application.in-memory-pauses]` naming the stores that are in memory (#644): the pause records,
 * the checkpoints, or both — the one a project left out is the one to list.
 */
function inMemoryPauses(records: boolean, checkpoints: boolean): AssemblyWarning {
  const stores = [
    ...(records
      ? ["the pause records (PausedExecutionRepository — list SqlitePausedExecutionRepository)"]
      : []),
    ...(checkpoints ? ["the checkpoints (BaseCheckpointSaver — list SqliteCheckpointSaver)"] : []),
  ];
  return {
    code: "application.in-memory-pauses",
    message: `in-memory pauses: ${stores.join(" and ")} are kept in memory — another application instance cannot resume a pause and it is lost on restart`,
  };
}

const IN_MEMORY_EXECUTION_HISTORY: AssemblyWarning = {
  code: "application.in-memory-execution-history",
  message:
    "in-memory execution history: retention.executionRecords keeps each instance's executions in its own memory — another instance and agboss records export do not see them, and they are lost on restart",
};

const IN_MEMORY_CHILD_QUEUE: AssemblyWarning = {
  code: "application.in-memory-child-queue",
  message:
    "in-memory child queue: children launched with placement: ChildPlacement.AnyInstance run only on the instance that launched them — list SqliteChildExecutionQueueRepository (or your own ChildExecutionQueueRepository) so any instance claims them",
};

const PII_INSTANCE_KEY: AssemblyWarning = {
  code: "application.pii-instance-key",
  message:
    "no @Application({ piiKeyField }): sensitive fields make PII tokens with a key of each execution — one value gets another token in each execution (in logs and traces: on each instance), so tokens compare across executions only with piiKeyField",
};

/** A listed fencing store that opts out of the atomic lease check (#526): what it gives up, and where to read why (#543). */
const notAtomic = (store: Class): AssemblyWarning => ({
  code: "application.lease-check-not-atomic",
  message: `${store.name} declares LeaseCheck.WithoutDoubleChargeProtection: it checks the lease outside its write's transaction, so a holder whose lease was taken over can still write — no protection against a double charge or a second owner's write; it passes no fencing case of storeConformance and must never back payments (Wiki → Your-own-store#an-opted-out-store-and-storeconformance-543)`,
});

/** The DTOs of a workflow's tools: an agent's `@Tool` / `@McpTool` input and output. */
const toolDtosOf = (workflow: AssembledWorkflow): readonly DtoClass[] =>
  [...workflow.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Agent) return [];
    return (declaration.options.tools ?? []).flatMap((cls): readonly DtoClass[] => {
      const component = componentOf(cls);
      return component?.kind === "tool" || component?.kind === "mcp-tool"
        ? [component.meta.input, component.meta.output]
        : [];
    });
  });

/**
 * Whether anything of the application makes a PII token (#644): a PII policy (the application's or
 * a workflow's), or a `sensitive` field of a DTO on a path, of a tool or of a context. Without one
 * the key a token would be made with is never used, and the instance-key warning is noise.
 */
function makesPiiTokens(sources: WarningSources): boolean {
  const workflows = sources.workflows;
  if ((sources.piiPolicies?.length ?? 0) > 0) return true;
  if (workflows.some((workflow) => (workflow.pii?.classes.length ?? 0) > 0)) return true;
  const contexts = [sources.tenantContext, sources.executionContext].flatMap((cls) =>
    cls === undefined ? [] : [cls as DtoClass],
  );
  const dtos = [
    ...contexts,
    ...workflows.flatMap((workflow) => [...workflow.graph.dtos.values(), ...toolDtosOf(workflow)]),
  ];
  return dtos.some(hasSensitiveFields);
}

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

/** `[a2a.inline-files-without-store]` (#859), when its A2A files ride inline above 64 KB. */
function inlineFilesOf(sources: WarningSources): AssemblyWarning[] {
  const message = inlineFilesWarningOf({
    name: sources.name ?? "the application",
    providers: sources.providers,
    exposes: sources.exposes ?? [],
    workflows: sources.workflows.map((workflow) => workflow.graph.type),
    a2aFiles: sources.a2aFiles,
  });
  return message === undefined ? [] : [{ code: "a2a.inline-files-without-store", message }];
}

/**
 * The assembly warnings (#261): tenant or application budgets on an in-memory ledger; possible
 * pauses with in-memory paused executions or checkpoints; children on any instance on an in-memory
 * queue (#333 PR 2); PII tokens on a key of the instance (#120); a fencing store that opts out of
 * the atomic lease check (#526).
 */
export function assemblyWarningsOf(sources: WarningSources): readonly AssemblyWarning[] {
  const choices = implementationsOf(sources.providers);
  const inMemory = (contract: Class): boolean => isInMemory(choices, contract);
  const found: readonly (readonly [boolean, AssemblyWarning])[] = [
    [hasPeriodBudget(sources.budgets) && inMemory(CostLedgerRepository), IN_MEMORY_LEDGER],
    [
      canPause(sources.workflows) &&
        (inMemory(PausedExecutionRepository) || inMemory(BaseCheckpointSaver)),
      inMemoryPauses(inMemory(PausedExecutionRepository), inMemory(BaseCheckpointSaver)),
    ],
    [
      sources.executionRecordRetention !== undefined && inMemory(ExecutionHistoryRepository),
      IN_MEMORY_EXECUTION_HISTORY,
    ],
    [
      launchesAnywhere(sources.workflows) && inMemory(ChildExecutionQueueRepository),
      IN_MEMORY_CHILD_QUEUE,
    ],
    [sources.isPiiKeyOfInstance === true && makesPiiTokens(sources), PII_INSTANCE_KEY],
  ];
  return [
    ...found.flatMap(([applies, warning]) => (applies ? [warning] : [])),
    ...notAtomicStoresOf(sources.providers).map(notAtomic),
    ...inlineFilesOf(sources),
    ...a2aCardWarningsOf(sources),
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
