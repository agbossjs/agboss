import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveTools, type AssembledWorkflow } from "../workflow.js";
import { validateAgentsConfig, type AgentsConfigOf } from "../config/types.js";
import type { ContainerOptions } from "../components/container/container.js";
import type { Environment } from "../environments/define.js";
import type { ObserverManager } from "../core/observer-manager.js";
import { startComponents } from "../components/container/lifecycle.js";
import { createFileLedger, type Clock, type SpendLedger } from "../finops/ledger.js";
import type { EvalDeps } from "../eval/eval.js";
import type { RunDeps } from "../run/types.js";
import { configSnapshot, runVersions } from "../run/versions.js";
import {
  createSqliteTernStore,
  shortVersion,
  stableJson,
  type NewThreadId,
  type TernStore,
} from "../terns/index.js";
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

/** Daily spend ledgers live outside the repo. */
export const DEFAULT_LEDGER_DIR = join(homedir(), ".langgraph-agents", "spend");

/** Terns (runs, threads, scores) live outside the repo. */
export const DEFAULT_TERN_DB = join(homedir(), ".langgraph-agents", "terns.sqlite");

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

/** Where an app keeps its state; each one given is shared and stays open when the app closes. */
export interface AppStores {
  /**
   * Where paused runs keep their graph state. Default: an in-process `MemorySaver` — dev and tests
   * only, a pause is lost on restart. In production give a durable `BaseCheckpointSaver` (e.g.
   * `SqliteSaver` / `PostgresSaver` from `@langchain/langgraph-checkpoint-*`) together with
   * `pausedRuns: createSqlitePausedRunRepository()`: `createApp(W, { stores: { checkpointer }, pausedRuns })`.
   */
  readonly checkpointer?: BaseCheckpointSaver;
  readonly ledger?: SpendLedger;
  readonly terns?: TernStore;
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
  /** The app's environment (`ENV`), resolved; absent = none (a service injecting `ENV` fails). */
  readonly environment?: Environment;
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
  readonly stores?: AppStores;
  /** The time for the ledger's day and the Terns. Default: the system clock. */
  readonly clock?: Clock;
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

/** The stores of an app: the ones given, else production defaults; `owned` are closed with the app. */
function storesOf(options: AppDepsOptions, env: NodeJS.ProcessEnv) {
  const clock = options.clock ?? ((): Date => new Date());
  const given = options.stores?.terns;
  const terns =
    given ?? createSqliteTernStore(env.TERN_DB ?? DEFAULT_TERN_DB, clock, options.newThreadId);
  return {
    terns,
    ownsTerns: given === undefined,
    ledger:
      options.stores?.ledger ?? createFileLedger(env.SPEND_LEDGER_DIR ?? DEFAULT_LEDGER_DIR, clock),
    // dev default: see AppStores.checkpointer
    checkpointer: options.stores?.checkpointer ?? new MemorySaver(),
  };
}

/** Collects the container's instances for their lifecycle hooks, keeping any hook already given. */
function lifecycleOf(container: ContainerOptions | undefined) {
  const created: unknown[] = [];
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
 * Production wiring of a workflow: its model providers behind the model gateway (every model setting
 * checked against its model first), MCP servers, file
 * spend ledger, Tern store; every part can be given instead (`options`, e.g. by `agboss/testing`).
 * Fails fast when an MCP server is unavailable or drifted. The components' `onInit` → `onStart` run at
 * the end; a failing one stops the start (MCP, tracing and the stores it opened are closed).
 */
export async function createAppDeps(
  bundle: AssembledWorkflow,
  options: AppDepsOptions = {},
): Promise<AppDeps> {
  const env = options.processEnv ?? process.env;
  const models = await modelsFor(bundle, options.gateway, providerClientsOf(options, env));
  const gateway = models.gateway;
  const lifecycle = lifecycleOf(options.container);
  const services = servicesFor(bundle, gateway, options.environment, lifecycle.options);
  const tools: readonly AnyTool[] = resolveTools(bundle, services);
  const toolNames = tools.map((tool) => tool.name);
  const config = models.priced(validateAgentsConfig(bundle.config, toolNames));
  const connect = options.connectMcp ?? connectConfigured(options.transport);
  const mcp = await connect(bundle, config, env);
  const { terns, ownsTerns, ledger, checkpointer } = storesOf(options, env);
  const tracing = await tracingOf(env);
  const deps = {
    config,
    registry: createModelRegistry(config, gateway),
    ...flowFor(bundle, config, gateway),
    prompts: bundle.prompts,
    guards: guardsFor(config, gateway),
    tools: toolLookup(tools),
    pause: pauseFor(bundle, checkpointer),
    compactionPrompt: bundle.compactionPrompt,
    ...componentsAtStart(bundle, services),
    ledger,
    terns,
    evaluation: evaluationFor(bundle, { terns, ledger }, gateway),
    tracing,
    ...(options.newRunId === undefined ? {} : { newRunId: options.newRunId }),
    close: closeOf(lifecycle.created, mcp, tracing, ownsTerns ? terns : undefined),
  };
  await startComponents(lifecycle.created).catch(async (error: unknown) => {
    await releaseOf(mcp, tracing, ownsTerns ? terns : undefined)();
    throw error;
  });
  return { ...deps, models: models.summary, warnings: await versionWarnings(deps) };
}
