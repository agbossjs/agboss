import type { JudgeHandler } from "./components/judge-decorators.js";
import type { BaseMemoryStrategy } from "./memory/types.js";
import type { AgentPrompts, AgentsConfigOf } from "./config/types.js";
import type { KnowledgeSource, RagConnector } from "./rag/types.js";
import type { Guardrail } from "./components/decorators.js";
import type { PauseChannel } from "./flow/runtime/pause.js";
import type { AssembledPii } from "./pii/assembly.js";
import type { Class } from "./components/injection.js";
import type { AnyTool, McpFacade, McpServerHandle } from "./tools/index.js";
import type { RouterEngine } from "./routers/index.js";
import type { RuntimeGraph } from "./flow/runtime/graph-model.js";
import type { ModelArbiterUse } from "./flow/runtime/launch/runtime-launch.js";
import type { LoadedRouter } from "./flow/runtime/routers.js";
import type { ModelProviderType } from "./models/model-provider.decorator.js";
import type { ContainerOptions } from "./components/container/container.js";
import type { RuntimeContexts } from "./flow/context/runtime-contexts.js";
import type { IncompatibleResumePolicy } from "./run/resume-guard.js";

/** What the core offers the tools of a workflow. */
export interface WorkflowServices {
  /** A router on the workflow's default router model (Jev) — cheap decisions inside tools. */
  readonly router: (name: string) => RouterEngine;
  /**
   * The application's context levels (#261, framework wiring — `RuntimeContexts` is internal,
   * `agboss/internal`): its `ApplicationContext` (with the environment) and
   * the declared context classes; absent = a workflow on its own (eval, replay), its own defaults.
   */
  readonly contexts?: RuntimeContexts;
  /** Framework wiring of the app's container: replacements (test mocks) and lifecycle. */
  readonly container?: ContainerOptions;
}

/** Tools as a list, or a factory when they need core services. */
/** Per agent or tool: its guardrail instances, and whether they replace the workflow's own. */
export interface ResolvedPolicies<TPolicy> {
  override: boolean;
  instances: readonly TPolicy[];
  disable: readonly Class[];
}

export type WorkflowTools =
  readonly AnyTool[] | ((services: WorkflowServices) => readonly AnyTool[]);

/**
 * Everything one workflow needs: its flow, steps limit and routers, config, prompts, the tools it may
 * use, the MCP servers behind its facades and, optionally, which tools wait for an approval (pause seam).
 */
export interface AssembledWorkflow<TName extends string = string> {
  readonly config: AgentsConfigOf<TName>;
  /** The workflow's graph: its paths analysed at assembly (every rule, all at once). */
  readonly graph: RuntimeGraph;
  /** Steps per execution: `@Workflow({ maxSteps })`, default (agents + routers) × 3. */
  readonly maxSteps: number;
  /**
   * Its application's model providers (`@Application({ providers })`, #266): the listed
   * `@ModelProvider` classes, else the built-in OpenRouter and Decisions providers.
   */
  readonly modelProviders: readonly ModelProviderType[];
  /** From the workflow's `settings()`: resumes of runs paused under another config; absent = reject. */
  readonly onIncompatibleResume?: IncompatibleResumePolicy | undefined;
  /** Every router of the flow with its texts loaded. */
  readonly routers: readonly LoadedRouter[];
  /** Its model arbiters (#279), by `name` and `model`: model uses like the routers'. */
  readonly arbiters?: readonly ModelArbiterUse[];
  readonly prompts: AgentPrompts<TName>;
  readonly tools: WorkflowTools;
  readonly mcpServers: readonly McpServerHandle<string>[];
  /** Every declared server tool, checked against its server at startup (`@McpServer({ tools })`). */
  readonly serverTools?: readonly McpFacade[];
  /** Agents' own memory strategies by agent name (`@Agent({ memoryStrategy })`). */
  readonly memoryStrategies?: (
    services: WorkflowServices,
  ) => ReadonlyMap<string, BaseMemoryStrategy>;
  /** The agents' `@Judge`s by judge name, created by the workflow's container. */
  readonly judges?: (services: WorkflowServices) => ReadonlyMap<string, JudgeHandler<unknown>>;
  /** Context-mode knowledge bases per agent (retrieved before the agent runs). */
  readonly knowledge?: (
    services: WorkflowServices,
  ) => ReadonlyMap<string, readonly KnowledgeSource[]>;
  /** Every knowledge base of the workflow (for `npm run rag:index`). */
  readonly knowledgeBases?: (
    services: WorkflowServices,
  ) => readonly { readonly name: string; readonly connector: RagConnector }[];
  /** Per tool: its constructor dependencies as a tree, e.g. `JobFitJudge (ROUTER_FACTORY), JOB_SEARCH`. */
  readonly toolDependencies?: Readonly<Record<string, string>>;
  /** Compaction prompt override (workflows with `compaction`). */
  readonly compactionPrompt?: string;
  /** The channels its tools name (#267), by name, created by the application's container. */
  readonly channels?: (services: WorkflowServices) => ReadonlyMap<string, PauseChannel>;
  /** A component by its class, from the workflow's container (created with its `deps` on first use). */
  readonly resolve: (services: WorkflowServices) => (token: Class) => unknown;
  /** Its PII policies (#120): per agent and router, for observability, and their model detections. */
  readonly pii?: AssembledPii;
  readonly guardrails?: (
    services: WorkflowServices,
  ) => ReadonlyMap<string, ResolvedPolicies<Guardrail>>;
  readonly toolGuardrails?: (
    services: WorkflowServices,
  ) => ReadonlyMap<string, ResolvedPolicies<Guardrail>>;
  readonly workflowGuardrails?: (services: WorkflowServices) => readonly Guardrail[];
}

export const resolveTools = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): readonly AnyTool[] =>
  typeof bundle.tools === "function" ? bundle.tools(services) : bundle.tools;
