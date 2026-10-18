import { resolveTools, type AssembledWorkflow } from "../workflow.js";
import { validateAgentsConfig, type AgentsConfigOf } from "../config/types.js";
import type { ContainerOptions } from "../components/container/container.js";
import type { Environment } from "../flow/generated-types.js";
import type { ObserverManager } from "../core/observer-manager.js";
import { startComponents, stopComponents } from "../components/container/lifecycle.js";
import type { EvalDeps } from "../eval/eval.js";
import type { RunDeps } from "../run/types.js";
import { configSnapshot, runVersions } from "../run/versions.js";
import { shortVersion, stableJson, type NewThreadId } from "../terns/index.js";
import { tracingOf } from "../tracing/index.js";
import type { ModelGateway } from "../llm/gateway.js";
import { createModelRegistry } from "../llm/registry.js";
import type { ProviderFetch } from "../models/resilient-fetch.js";
import { modelsFor, providerClientsOf } from "./models.js";
import {
  connectMcpServers,
  type AnyTool,
  type McpConnections,
  type TransportFactory,
} from "../tools/index.js";
import { evaluationFor, flowFor, guardsFor, pauseFor, servicesFor, toolLookup } from "./parts.js";
import { closeOf, releaseOf } from "./app-deps-parts.js";
import { componentsAtStart } from "./start-components.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Clock } from "../infrastructure/clock.js";
import {
  standaloneBudgetsOf,
  standaloneInfrastructure,
} from "../application/application-container.js";
import type { ApplicationBudgets } from "../budgets/execution-budgets.js";
import type { BudgetHandler } from "../budgets/budget.js";
import type { Class } from "../components/injection.js";
import { standaloneContexts, type RuntimeContexts } from "../flow/context/runtime-contexts.js";

/** Run dependencies, eval dependencies, and resources to release after the run. */
export interface AppDeps extends RunDeps<string> {
  readonly observer: ObserverManager;
  readonly evaluation: EvalDeps;
  /** Startup warnings, e.g. a config changed without a version bump. */
  readonly warnings: readonly string[];
  /** One line per model use: its provider, reasoning and caching (the startup log). */
  readonly models: readonly string[];
  /**
   * Runs `onStop` of the components, waits for `executionsDone` (the running executions), runs
   * `onDestroy`, then closes MCP connections, tracing and the stores it opened.
   */
  readonly close: (executionsDone?: () => Promise<void>) => Promise<void>;
}

/** How the MCP servers of a workflow get connected (default: their configured transports). */
export type McpConnect = (
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  env: NodeJS.ProcessEnv,
) => Promise<McpConnections>;

/** Everything an app may be given instead of its production default. */
export interface AppDepsOptions {
  /** The process environment: model provider keys, MCP servers, stores. Default: process.env. */
  readonly processEnv?: NodeJS.ProcessEnv;
  /**
   * The app's environment values, resolved (`applicationContext.environment`); absent = none —
   * an empty environment.
   */
  readonly environment?: Environment;
  /** The chosen environment's name (`applicationContext.environmentName`); default `dev`. */
  readonly environmentName?: string;
  /**
   * Every model call goes through it. Default: the workflow's model providers, credentials from
   * `processEnv`, each model's settings checked against what its provider says it supports.
   */
  readonly gateway?: ModelGateway;
  /** The raw HTTP client under every model provider (default: global fetch; tests: a local stub). */
  readonly providerFetch?: ProviderFetch;
  /** MCP transports by server (default: stdio / streamable HTTP from the server's config). */
  readonly transport?: TransportFactory;
  /** Replaces how MCP servers are connected (test stubs). */
  readonly connectMcp?: McpConnect;
  readonly newThreadId?: NewThreadId;
  readonly newRunId?: () => string;
  readonly container?: ContainerOptions;
}

/** Stores the config snapshot of this version; warns when the version already had other content. */
async function versionWarnings(deps: RunDeps<string>): Promise<string[]> {
  const { configVersion, configHash } = runVersions(deps);
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

const connectConfigured =
  (transport: TransportFactory | undefined): McpConnect =>
  (bundle, config, env) =>
    connectMcpServers(
      config.mcpServers,
      bundle.mcpServers,
      bundle.serverTools ?? [],
      env,
      transport,
    );

/**
 * What the application gives each of its workflows: the infrastructure (one per application) and,
 * when the application runs the lifecycle hooks itself (all its workflows' components at once), the
 * list its container's instances go into.
 */
export interface WorkflowDepsParts {
  readonly infrastructure: Infrastructure;
  /** The application's instances in creation order; absent = this workflow runs its own hooks. */
  readonly created?: unknown[];
  /** The application's context levels (#261); absent = the workflow's own (a workflow on its own). */
  readonly contexts?: RuntimeContexts;
  /** The application's budgets (#261): every `@Budget` it lists and its name; absent = none. */
  readonly budgets?: BudgetListing;
}

/** The budgets an application lists, and its name (the key of its application budgets). */
export interface BudgetListing {
  readonly budgets: readonly Class[];
  readonly applicationName: string;
}

/** The application's budgets as a workflow runs them: instances from its container, its ledger. */
const budgetsOf = (
  listing: BudgetListing | undefined,
  container: { readonly get: <T>(token: Class<T>) => T },
  infrastructure: Infrastructure,
  clock: Clock,
): ApplicationBudgets | undefined =>
  listing === undefined
    ? undefined
    : {
        ...listing,
        resolve: (budget) => container.get(budget as Class<BudgetHandler>),
        ledger: infrastructure.costLedger,
        clock,
      };

/** Collects the container's instances for their lifecycle hooks, keeping any hook already given. */
function lifecycleOf(container: ContainerOptions | undefined, created: unknown[] = []) {
  const options: ContainerOptions = {
    ...container,
    onCreate: (instance) => {
      created.push(instance);
      container?.onCreate?.(instance);
    },
  };
  return { created, options };
}

/**
 * The run dependencies of one workflow of an application: its model providers behind the model
 * gateway (every model setting checked against its model first), MCP servers, and the application's
 * infrastructure. Fails fast when an MCP server is unavailable or drifted. Without `parts.created`
 * the components' `onInit` → `onStart` run at the end (a failing one stops the start, MCP and
 * tracing are closed); with it the application runs them once for all its workflows.
 */
export async function createWorkflowDeps(
  bundle: AssembledWorkflow,
  options: AppDepsOptions,
  parts: WorkflowDepsParts,
): Promise<AppDeps> {
  const env = options.processEnv ?? process.env;
  const { clock } = parts.infrastructure;
  const clients = providerClientsOf(options, env, clock);
  const models = await modelsFor(bundle, options.gateway, clients);
  const gateway = models.gateway;
  const lifecycle = lifecycleOf(options.container, parts.created);
  const contexts = parts.contexts ?? standaloneContexts(bundle.config, options.environment, clock);
  const services = servicesFor(bundle, gateway, contexts, lifecycle.options);
  const tools: readonly AnyTool[] = resolveTools(bundle, services);
  const toolNames = tools.map((tool) => tool.name);
  const config = models.priced(validateAgentsConfig(bundle.config, toolNames));
  const connect = options.connectMcp ?? connectConfigured(options.transport);
  const mcp = await connect(bundle, config, env);
  const { records: terns, checkpointer } = parts.infrastructure;
  const tracing = await tracingOf(env);
  const ownsHooks = parts.created === undefined;
  const components = componentsAtStart(bundle, services);
  const budgets = budgetsOf(parts.budgets, components.container, parts.infrastructure, clock);
  const deps = {
    config,
    registry: createModelRegistry(config, gateway),
    ...flowFor(bundle, config, gateway),
    prompts: bundle.prompts,
    guards: guardsFor(config, gateway),
    tools: toolLookup(tools),
    pause: pauseFor(bundle, checkpointer),
    compactionPrompt: bundle.compactionPrompt,
    ...components,
    budgets,
    terns,
    evaluation: evaluationFor(bundle, { terns, budgets }, gateway),
    tracing,
    contexts,
    clock,
    ...(options.newRunId === undefined ? {} : { newRunId: options.newRunId }),
    close: closeOf(ownsHooks ? lifecycle.created : undefined, mcp, tracing),
  };
  if (ownsHooks) {
    await startComponents(lifecycle.created).catch(async (error: unknown) => {
      await releaseOf(mcp, tracing)();
      throw error;
    });
  }
  return { ...deps, models: models.summary, warnings: await versionWarnings(deps) };
}

/**
 * The run dependencies of one workflow on its own (eval, replay, golden, compare): on the
 * infrastructure of the application that lists it (its `providers` — e.g. the SQLite
 * implementations, so records persist across processes), else the built-in in-memory one, and
 * its own lifecycle hooks; `close()` also closes what the infrastructure opened.
 */
export async function createAppDeps(
  bundle: AssembledWorkflow,
  options: AppDepsOptions = {},
): Promise<AppDeps> {
  const opened: unknown[] = [];
  const infrastructure = standaloneInfrastructure(bundle, options, (instance) => {
    opened.push(instance);
  });
  await startComponents(opened);
  const budgets = standaloneBudgetsOf(bundle);
  const parts = { infrastructure, ...(budgets === undefined ? {} : { budgets }) };
  const deps = await createWorkflowDeps(bundle, options, parts).catch(async (error: unknown) => {
    await stopComponents(opened);
    throw error;
  });
  return {
    ...deps,
    close: async (executionsDone) => {
      try {
        await deps.close(executionsDone);
      } finally {
        await stopComponents(opened);
      }
    },
  };
}
