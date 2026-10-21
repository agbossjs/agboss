import { resolveTools, type AssembledWorkflow } from "../workflow.js";
import { validateAgentsConfig, type AgentsConfigOf } from "../config/types.js";
import type { ContainerOptions } from "../components/container/container.js";
import type { Environment } from "../flow/generated-types.js";
import type { ExecutionObserverManager } from "../core/observer-manager.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { startComponents } from "../components/container/lifecycle.js";
import type { EvalDeps } from "../eval/eval.js";
import type { RunDeps } from "../run/types.js";
import { configSnapshot, runVersions } from "../run/versions.js";
import { shortVersion, stableJson } from "../terns/index.js";
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
import {
  evaluationFor,
  flowFor,
  guardrailsFor,
  pauseFor,
  repliesFor,
  servicesFor,
  toolLookup,
} from "./parts.js";
import { closeOf, observedBy, treeDepsOf, releaseOf } from "./app-deps-parts.js";
import { componentsAtStart } from "./start-components.js";
import { piiFor } from "./pii-parts.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { Clock } from "../infrastructure/clock.js";
import type { BranchScheduler } from "../flow/runtime/launch/branch-schedule.js";
import type { ApplicationBudgets } from "../budgets/execution-budgets.js";
import type { BudgetHandler } from "../budgets/budget.js";
import type { Class } from "../components/injection.js";
import { standaloneContexts, type RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { GraphDeps } from "../graph/deps.js";
import type { ReplyReaderParts } from "../channels/reply-reader.js";

/** Run dependencies, eval dependencies, and resources to release after the run. */
export interface AppDeps extends RunDeps<string> {
  /** The application's observers (`@Application({ observers })`); none for a workflow on its own. */
  readonly observer: ExecutionObserverManager;
  /** The application's log (its `Logger`, stamped by its clock). */
  readonly log: FrameworkLog;
  readonly evaluation: EvalDeps;
  /** Startup warnings, e.g. a config changed without a version bump. */
  readonly warnings: readonly string[];
  /** One line per model use: its provider, reasoning and caching (the startup log). */
  readonly models: readonly string[];
  /** The reply interpreters of its tree's channel roles (#267 PR 3): `app.resume({ reply })`. */
  readonly replies: ReplyReaderParts;
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
  readonly container?: ContainerOptions;
  /** How launch branches are scheduled: a test's `TestConcurrency` (#262 S33); default the real way. */
  readonly branchScheduler?: BranchScheduler;
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
  /** The application's observers (#261), one manager for all its workflows; absent = none. */
  readonly observer?: ExecutionObserverManager;
  /** The key of the tokens of `sensitive` fields (#120), one per instance; absent = a new one. */
  readonly piiFieldKey?: string;
  /** The run dependencies of the application's other workflows, its children's (#263). */
  readonly childDepsOf?: (workflow: Class) => GraphDeps<string> | undefined;
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

const nameOfTool = (tool: AnyTool): string => tool.name;

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
  const { clock, records: terns, checkpointer } = parts.infrastructure;
  const contexts = parts.contexts ?? standaloneContexts(bundle.config, options.environment, clock);
  const clients = providerClientsOf(options, contexts.application, parts.infrastructure);
  const { gateway, ...models } = await modelsFor(bundle, options.gateway, clients);
  const lifecycle = lifecycleOf(options.container, parts.created);
  const services = servicesFor(bundle, gateway, contexts, lifecycle.options);
  const tools: readonly AnyTool[] = resolveTools(bundle, services);
  const config = models.priced(validateAgentsConfig(bundle.config, tools.map(nameOfTool)));
  const connect = options.connectMcp ?? connectConfigured(options.transport);
  const mcp = await connect(bundle, config, env);
  const pii = piiFor(bundle, config, { gateway, services, contexts, env }, parts.piiFieldKey);
  const tracing = await tracingOf(env, pii.observability);
  const components = componentsAtStart(bundle, services);
  const budgets = budgetsOf(parts.budgets, components.container, parts.infrastructure, clock);
  const deps = {
    config,
    registry: createModelRegistry(config, gateway),
    ...flowFor(bundle, config, gateway, options.branchScheduler),
    prompts: bundle.prompts,
    guardrails: guardrailsFor(bundle, services, config, gateway),
    tools: toolLookup(tools),
    pause: pauseFor(checkpointer, parts.infrastructure.pausedExecutions, terns),
    ...(bundle.compactions === undefined ? {} : { compactions: bundle.compactions }),
    ...components,
    pii,
    budgets,
    terns,
    evaluation: evaluationFor(bundle, { terns, budgets }, gateway),
    tracing,
    contexts,
    clock,
    replies: repliesFor(bundle, config, gateway, components.container),
    ...observedBy(parts.observer, parts.infrastructure.logger, clock, pii.observability),
    ...treeDepsOf(parts.infrastructure.idGenerator, parts.childDepsOf),
    close: closeOf(parts.created === undefined ? lifecycle.created : undefined, mcp, tracing),
  };
  if (parts.created === undefined) {
    await startComponents(lifecycle.created).catch(async (error: unknown) => {
      await releaseOf(mcp, tracing)();
      throw error;
    });
  }
  return { ...deps, models: models.summary, warnings: await versionWarnings(deps) };
}

export { createAppDeps } from "./standalone-deps.js";
