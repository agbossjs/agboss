import type { PauseChannel } from "../flow/runtime/pause.js";
import type { Class } from "../components/injection.js";
import { stopComponents } from "../components/container/lifecycle.js";
import { ExecutionObserverManager } from "../core/observer-manager.js";
import type { Clock, IdGenerator } from "../infrastructure/clock.js";
import { frameworkLogOf, type FrameworkLog, type Logger } from "../infrastructure/logger.js";
import type { McpConnections } from "../tools/index.js";
import type { ExecutionTracing } from "../tracing/index.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { GraphDeps } from "../graph/deps.js";
import type { AgentExecutionDeps } from "../run/types.js";
import { configSnapshot, executionVersions } from "../run/versions.js";
import { shortVersion, stableJson } from "../terns/index.js";
import type { StepSlots } from "./step-slots.js";
import type { StepEntries } from "../flow/runtime/step-entries.js";
import type { CompensationParts } from "../flow/runtime/compensation/registry.js";
import type { RemoteChildren } from "../flow/runtime/remote/remote-child.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { ApplicationContext } from "../flow/context/application-context.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { ExecutionHistoryRepository } from "../infrastructure/execution-history.repository.js";
import type { ExecutionLeaseEventRepository } from "../infrastructure/execution-lease-event.repository.js";
import type { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
import type { ExecutionRecordRepository } from "../infrastructure/execution-record.repository.js";
import type { PiiRuntime } from "../pii/runtime.js";

/**
 * The workflow's channel of a name (#267). The channels are created here, with the app (so their
 * lifecycle hooks run and a missing dependency fails at start).
 */
export const channelLookup = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): ((channelName: string) => PauseChannel) => {
  const channels = bundle.channels?.(services);
  return (channelName: string): PauseChannel => {
    const channel = channels?.get(channelName);
    if (!channel) throw new Error(`Unknown channel: ${channelName}`);
    return channel;
  };
};

/** The container's instances: lookup by class. */
export interface ContainerDeps {
  readonly container: { readonly get: <T>(token: Class<T>) => T };
}

export function containerDepsOf(
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): ContainerDeps {
  const resolve = bundle.resolve(services);
  return {
    container: {
      // the container creates `token` itself: the instance is of that class
      get: <T>(token: Class<T>): T => resolve(token) as T,
    },
  };
}

/**
 * The application's observers (none for a workflow on its own) and its log, stamped by its clock —
 * both masked by the workflow's observability policies (#120 AC7).
 */
export const observedBy = (
  observer: ExecutionObserverManager | undefined,
  logger: Logger,
  clock: Clock,
  mask: ObservabilityMask,
): { readonly observer: ExecutionObserverManager; readonly log: FrameworkLog } => ({
  observer: (observer ?? new ExecutionObserverManager([])).masked((event) => mask.value(event)),
  log: frameworkLogOf(logger, clock, (message) => mask.text(message)),
});

/** Closes what the app opened besides its components: MCP connections, tracing. */
export const releaseOf =
  (mcp: McpConnections, tracing: ExecutionTracing | undefined) => async (): Promise<void> => {
    try {
      await mcp.close();
    } finally {
      await tracing?.shutdown();
    }
  };

/**
 * The stop of a workflow's parts (#261): with `created` (its own hooks) `onStop` of the
 * components, the running executions awaited, `onDestroy`; without (the application runs the hooks)
 * the executions awaited only. Then MCP and tracing — also when a hook failed.
 */
export const closeOf =
  (created: unknown[] | undefined, mcp: McpConnections, tracing: ExecutionTracing | undefined) =>
  async (executionsDone?: () => Promise<void>): Promise<void> => {
    try {
      if (created === undefined) await executionsDone?.();
      else await stopComponents(created, executionsDone);
    } finally {
      await releaseOf(mcp, tracing)();
    }
  };

/** What the instance gives each workflow's tree (#263, #332, #367). */
export interface TreeParts {
  readonly childDepsOf?: ((workflow: Class) => GraphDeps<string> | undefined) | undefined;
  readonly stepSlots?: StepSlots | undefined;
  readonly stepEntries?: StepEntries | undefined;
  readonly compensation?: CompensationParts | undefined;
  /** The instance's queue of children on any instance (#333 PR 2). */
  readonly remoteChildren?: RemoteChildren | undefined;
}

/**
 * What a workflow's deps make its tree with: its ids (#313), its children's deps when given (#263),
 * the instance's step slots when the application caps them (#332), its running step bodies (#367).
 */
export const treeDepsOf = (
  idGenerator: IdGenerator,
  { childDepsOf, stepSlots, stepEntries, compensation, remoteChildren }: TreeParts,
): Pick<
  GraphDeps<string>,
  "childDepsOf" | "idGenerator" | "stepSlots" | "stepEntries" | "compensation" | "remoteChildren"
> => ({
  idGenerator,
  ...(childDepsOf === undefined ? {} : { childDepsOf }),
  ...(stepSlots === undefined ? {} : { stepSlots }),
  ...(stepEntries === undefined ? {} : { stepEntries }),
  ...(compensation === undefined ? {} : { compensation }),
  ...(remoteChildren === undefined ? {} : { remoteChildren }),
});

/** Stores the config snapshot of this version; warns when the version already had other content. */
export async function versionWarnings(deps: AgentExecutionDeps<string>): Promise<string[]> {
  const { configVersion, configHash } = executionVersions(deps);
  const { drift } = await deps.terns.rememberConfig(
    deps.config.name,
    configVersion,
    configHash,
    stableJson(configSnapshot(deps)),
  );
  return drift
    ? [
        `config "${deps.config.name}" ${configVersion} changed without a version bump (hash ${shortVersion(configHash)})`,
      ]
    : [];
}

/** What a workflow saves its roots' history with: the store and what a record is made of. */
export interface ExecutionHistoryKeeper {
  readonly repository: ExecutionHistoryRepository;
  readonly clock: Clock;
  readonly application: ApplicationContext;
  /** The workflow's observability mask: what a trace shows of a value. */
  readonly mask: ObservabilityMask;
  /** Who answered each pause of a tree (#267 S107). */
  readonly answers: Pick<ExecutionRecordRepository, "findPauseAnswersByTenantIdAndRootExecutionId">;
  /** The lease log (#501): a record carries its tree's rows as they stand when it is saved. */
  readonly leaseEvents?: LeaseEventsReader | undefined;
  /** The calls that left the system (#505): a record carries its tree's as they stand when saved. */
  readonly outboundCalls?: OutboundCallsReader | undefined;
}

/** What a record reads of the outbound calls: its tree's. */
export type OutboundCallsReader = Pick<
  OutboundCallRepository,
  "findAllByTenantIdAndRootExecutionId"
>;

/** What a record reads of the lease log: its tree's rows. */
export type LeaseEventsReader = Pick<
  ExecutionLeaseEventRepository,
  "findAllByTenantIdAndRootExecutionIdOrderByOccurredAt"
>;

/** What a keeper is made from: the workflow's clock, contexts, PII runtime and pause answers. */
export interface ExecutionHistoryParts {
  readonly clock: Clock;
  readonly contexts: Pick<RuntimeContexts, "application">;
  readonly pii: Pick<PiiRuntime, "observability">;
  readonly answers: ExecutionHistoryKeeper["answers"];
}

/** Where a workflow's history goes (#401) and what it reads of the lease log (#501). */
export interface HistorySources {
  readonly executionHistory?: ExecutionHistoryRepository | undefined;
  readonly infrastructure: {
    readonly leaseEvents?: LeaseEventsReader | undefined;
    readonly outboundCalls?: OutboundCallsReader | undefined;
  };
}

/** A workflow's keeper, when its application keeps the history; nothing otherwise. */
export const historyKeeperOf = (
  sources: HistorySources,
  parts: ExecutionHistoryParts,
): { readonly executionHistory?: ExecutionHistoryKeeper } =>
  sources.executionHistory === undefined
    ? {}
    : {
        executionHistory: {
          repository: sources.executionHistory,
          clock: parts.clock,
          application: parts.contexts.application,
          mask: parts.pii.observability,
          answers: parts.answers,
          leaseEvents: sources.infrastructure.leaseEvents,
          outboundCalls: sources.infrastructure.outboundCalls,
        },
      };
