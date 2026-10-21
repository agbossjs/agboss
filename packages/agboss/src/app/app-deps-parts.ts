import type { PauseChannel } from "../flow/runtime/pause.js";
import type { Class } from "../components/injection.js";
import { stopComponents } from "../components/container/lifecycle.js";
import { ExecutionObserverManager } from "../core/observer-manager.js";
import type { Clock, IdGenerator } from "../infrastructure/clock.js";
import { frameworkLogOf, type FrameworkLog, type Logger } from "../infrastructure/logger.js";
import type { McpConnections } from "../tools/index.js";
import type { RunTracing } from "../tracing/index.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { GraphDeps } from "../graph/deps.js";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";

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
  (mcp: McpConnections, tracing: RunTracing | undefined) => async (): Promise<void> => {
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
  (created: unknown[] | undefined, mcp: McpConnections, tracing: RunTracing | undefined) =>
  async (executionsDone?: () => Promise<void>): Promise<void> => {
    try {
      if (created === undefined) await executionsDone?.();
      else await stopComponents(created, executionsDone);
    } finally {
      await releaseOf(mcp, tracing)();
    }
  };

/** What a workflow's deps make its tree with: its ids (#313), its children's deps when given (#263). */
export const treeDepsOf = (
  idGenerator: IdGenerator,
  childDepsOf: ((workflow: Class) => GraphDeps<string> | undefined) | undefined,
): Pick<GraphDeps<string>, "childDepsOf" | "idGenerator"> => ({
  idGenerator,
  ...(childDepsOf === undefined ? {} : { childDepsOf }),
});
