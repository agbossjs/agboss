import type { BudgetOverlays } from "./budgets/budget-overlay.js";
import type { ComponentOptions } from "./components/component-options.js";
import type { BusinessKeyWriterUse } from "./components/container/fenced-reach.js";
import type { JudgeInstance } from "./components/judge-decorators.js";
import type { AgentPrompts, AgentsConfigOf } from "./config/types.js";
import type { McpServerConfig } from "./config/mcp-server-config.js";
import type { KnowledgeSource, RagIndexOptions, RagIndexReport, RagScope } from "./rag/types.js";
import type { ModelBinding } from "./llm/registry.js";
import type { PauseTarget } from "./flow/runtime/pause-channel.js";
import type { AssembledPii } from "./pii/assembly.js";
import type { AssembledGuardrails } from "./guardrails/assembly.js";
import type { AssembledToolInterceptors } from "./tool-interceptors/assembly.js";
import type { AssembledMemories } from "./memory/assembly.js";
import type { Class } from "./components/injection.js";
import type { AnyTool, McpFacade, McpServerHandle } from "./tools/index.js";
import type { RouterEngine } from "./routers/index.js";
import type { RuntimeGraph } from "./flow/runtime/graph-model.js";
import type { ModelArbiterUse } from "./flow/runtime/launch/runtime-launch.js";
import type { LoadedRouter } from "./flow/runtime/routers.js";
import type { DecisionService, DecisionTargetOf } from "./components/decision-model.js";
import type { ModelProviderType } from "./models/model-provider.decorator.js";
import type { ContainerOptions } from "./components/container/container.js";
import type { RuntimeContexts } from "./flow/context/runtime-contexts.js";
import type { IncompatibleResumePolicy } from "./run/resume-guard.js";
import type { AssembledReplyInterpreter } from "./channels/discovery.js";

/** A model `@RagReranker`'s model as its cascade resolved it: the vendor's name, its provider, its price mark. */
export interface RerankerModelUse {
  readonly name: string;
  readonly model: string;
  readonly modelProvider?: string;
  /** Its provider has no `cost`: its calls are 0 USD records with their tokens. */
  readonly unpriced?: true;
}

/** What the core offers the tools of a workflow. */
export interface WorkflowServices {
  /** A router on the workflow's default router model (Jev) — cheap decisions inside tools. */
  readonly router: (name: string) => RouterEngine;
  /** The model behind the injectable `DecisionModel` (#1313): a call resolved through the cascade, the gateway, its cost in the outcome; absent: none. */
  readonly decide?: DecisionService;
  /**
   * The application's context levels (#261, framework wiring — `RuntimeContexts` is internal,
   * `@agboss/core/internal`): its `ApplicationContext` (with the environment) and
   * the declared context classes; absent = a workflow on its own (eval, replay), its own defaults.
   */
  readonly contexts?: RuntimeContexts;
  /** Framework wiring of the app's container: replacements (test mocks) and lifecycle. */
  readonly container?: ContainerOptions;
  /**
   * Only `agboss check` and `describe` set it (#266): a `defineEnv` read through `deps: [appEnv]`
   * resolves an unset required value to a placeholder and an unset secret to an unresolved one, as
   * they need no variable and no key. Absent = strict: an unset required variable is
   * `[environment.missing-variable]` (every run, `rag index` included).
   */
  readonly deferredEnv?: boolean;
  /**
   * A model `@Reranker`'s chat model (#703), through the application's model gateway with the
   * workflow's chat defaults; absent where no gateway is (describe, the CLI's index).
   */
  readonly rerankModel?: (reranker: RerankerModelUse) => ModelBinding;
  /** A model `@RagReranker`'s `prompt` as assembly read it (#1347); absent: none. */
  readonly rerankInstructions?: (reranker: string) => string;
}

/** Tools as a list, or a factory when they need core services. */
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
  /** Steps per execution: `@Workflow({ maxSteps })`, default (agents + routers + actions + external tasks) × 3. */
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
  /** Where a `DecisionModel` call goes: the model and provider its options and the cascade resolve (#1313). */
  readonly decisionTargetOf?: DecisionTargetOf;
  /** Its model arbiters (#279), by `name` and `model`: model uses like the routers'. */
  readonly arbiters?: readonly ModelArbiterUse[];
  /** The reply interpreters of its tree's channel roles (#267 PR 3). */
  readonly replyInterpreters?: readonly AssembledReplyInterpreter[];
  readonly prompts: AgentPrompts<TName>;
  readonly tools: WorkflowTools;
  readonly mcpServers: readonly McpServerHandle<string>[];
  /** The connection of each `@McpServer` the workflow reaches through its `deps`, by server name. */
  readonly mcpServerConfigs?: Readonly<Record<string, McpServerConfig>>;
  /** The `@McpServer` classes the workflow reaches, and their names. */
  readonly mcpServerClasses?: ReadonlyMap<Class, string>;
  /** Every declared server tool, checked against its server at startup (`@McpServer({ tools })`). */
  readonly serverTools?: readonly McpFacade[];
  /** The agents' `@Judge`s by judge name, created by the workflow's container. */
  readonly judges?: (services: WorkflowServices) => ReadonlyMap<string, JudgeInstance>;
  /** Context-mode knowledge bases per agent (retrieved before the agent runs). */
  readonly knowledge?: (
    services: WorkflowServices,
  ) => ReadonlyMap<string, readonly KnowledgeSource[]>;
  /** Its knowledge bases' model rerankers, by name and resolved model: model uses `ragRerankers.<name>`. */
  readonly rerankers?: readonly (RerankerModelUse & {
    /** Its `prompt` as assembly read it (#1347). */
    readonly prompt?: string;
  })[];
  /** Every knowledge base of the workflow (for `npm run rag:index`). */
  readonly knowledgeBases?: (services: WorkflowServices) => readonly {
    readonly name: string;
    readonly scope: RagScope;
    /** Builds or updates one scope's index; `undefined` for a source without `index`. */
    readonly index: (options: RagIndexOptions) => Promise<RagIndexReport | undefined>;
  }[];
  /** Per tool: its constructor dependencies as a tree, e.g. `JobFitJudge (ROUTER_FACTORY), JOB_SEARCH`. */
  readonly toolDependencies?: Readonly<Record<string, string>>;
  /** Its memories (#1303): every one in use, with its prompt, and each reader's. */
  /**
   * A component of the workflow that can make a business key (#825: it reaches `OutboundCalls` or a
   * fenced-effect store), and what it reaches; absent = none — its application then needs no
   * idempotency key for it.
   */
  readonly businessKeyWriter?: BusinessKeyWriterUse;
  readonly memories?: AssembledMemories;
  /** The pause targets its tools and steps name (#267, #1307), by name, with their channels, created by the application's container. */
  readonly pauseTargets?: (services: WorkflowServices) => ReadonlyMap<string, PauseTarget>;
  /** A component by its class, from the workflow's container (created with its `deps` on first use). */
  readonly resolve: (services: WorkflowServices) => (token: Class) => unknown;
  /** Its PII policies (#120): per agent and router, for observability, and their model detections. */
  readonly pii?: AssembledPii;
  /** Its guardrails (#120): per agent and model router by side, their texts and models resolved. */
  readonly guardrails?: AssembledGuardrails;
  /** The application's own `FileTranscriber` (#899): the built-in's model is no use then; its class is in `configHash` (#1269). */
  readonly ownFileTranscriber?: Class | undefined;
  /** The application's own `FileRedactor` (#899): the built-in's model is no use then; its `supports` answers at start; its class is in `configHash` (#1269). */
  readonly ownFileRedactor?: Class | undefined;
  /** What the profile this workflow was assembled under changes of the budgets, so a run on its own (eval, replay) counts them as the application does. */
  readonly budgetOverlays?: BudgetOverlays | undefined;
  /** The options of the components under the profile this workflow was assembled under: what a run on its own is bounded by. */
  readonly componentOptions?: ComponentOptions | undefined;
  /** The application lists an `FileRepository` that keeps files (#899 §7): not the inline default. */
  readonly hasFileStore?: boolean;
  /** Its tool interceptors (#384): each agent's chain per tool, outer first. */
  readonly toolInterceptors?: AssembledToolInterceptors;
}

export const resolveTools = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): readonly AnyTool[] =>
  typeof bundle.tools === "function" ? bundle.tools(services) : bundle.tools;
