import type {
  ChannelRequest,
  Guardrail,
  InboundChannelAdapter,
  PiiPolicy,
} from "../components/decorators.js";
import type { Class } from "../components/injection.js";
import { stopComponents } from "../components/container/lifecycle.js";
import type { McpConnections } from "../tools/index.js";
import type { RunTracing } from "../tracing/index.js";
import type { AssembledWorkflow, ResolvedPolicies, WorkflowServices } from "../workflow.js";

/**
 * Dispatches an approval request to the workflow's channel of that name. The channels are created
 * here, with the app (so their lifecycle hooks run and a missing dependency fails at start).
 */
export const approvalRequester = (bundle: AssembledWorkflow, services: WorkflowServices) => {
  const channels = bundle.channels?.(services);
  return async (channelName: string, req: ChannelRequest): Promise<void> => {
    const channel = channels?.get(channelName);
    if (!channel) throw new Error(`Unknown channel: ${channelName}`);
    await channel.requestApproval(req);
  };
};

/** No policies of its own: the workflow's apply. */
const noPolicies = (): ResolvedPolicies<never> => ({ override: false, instances: [], disable: [] });

/** Per agent and per tool: its PII policies and guardrails; the workflow's own; channel adapters. */
export interface PolicyDeps {
  readonly piiPolicies: (agent: string) => ResolvedPolicies<PiiPolicy>;
  readonly toolPiiPolicies: (tool: string) => ResolvedPolicies<PiiPolicy>;
  readonly toolGuardrails: (tool: string) => ResolvedPolicies<Guardrail>;
  readonly workflowPiiPolicies: readonly PiiPolicy[];
  readonly workflowGuardrails: readonly Guardrail[];
  readonly guardrails: (agent: string) => ResolvedPolicies<Guardrail>;
  readonly channelAdapters: (channel: string) => InboundChannelAdapter | undefined;
}

export const policyDepsOf = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
  adapters = bundle.channelAdapters?.(services),
): PolicyDeps => ({
  piiPolicies: (agent: string) => bundle.piiPolicies?.(services).get(agent) ?? noPolicies(),
  toolPiiPolicies: (tool: string) => bundle.toolPiiPolicies?.(services).get(tool) ?? noPolicies(),
  toolGuardrails: (tool: string) => bundle.toolGuardrails?.(services).get(tool) ?? noPolicies(),
  workflowPiiPolicies: bundle.workflowPiiPolicies?.(services) ?? [],
  workflowGuardrails: bundle.workflowGuardrails?.(services) ?? [],
  guardrails: (agent: string) => bundle.guardrails?.(services).get(agent) ?? noPolicies(),
  channelAdapters: (channel: string) => adapters?.get(channel),
});

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
