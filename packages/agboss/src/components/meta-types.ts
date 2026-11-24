import type { PromptValue } from "./prompt-source.js";
import type { AgentSettings, AgentsConfig } from "../config/types.js";
import type { ModelFiles } from "../files/model-files.js";
import type { RagMode } from "../rag/types.js";
import type { AgentToolClass } from "./decorators.js";
import type { BaseMemoryStrategy } from "../memory/types.js";
import type { ModelCascade } from "../models/model-cascade.js";
import type { Class, Provider } from "./injection.js";
import type { UncompactedTurns } from "../compaction/compaction.decorator.js";

/** An agent's use of a `@Rag` knowledge base; both fields required (no defaults). */
export interface RagBinding {
  readonly use: Class;
  readonly mode: RagMode;
}

/**
 * The guardrails an agent or a router adds to what it inherits (`@Application` → `@Workflow`), and
 * the inherited ones it removes for its own model (#120): `@InputGuardrail` / `@OutputGuardrail`
 * classes.
 */
export interface GuardrailFields {
  readonly guardrails?: readonly Class[];
  readonly excludeGuardrails?: readonly Class[];
}

/**
 * The tool interceptors an agent adds to what it inherits (`@Application` → `@Workflow`) for every
 * call it makes to its tools, and the inherited ones it removes (#384): `@ToolInterceptor` classes.
 */
export interface ToolInterceptorFields {
  readonly toolInterceptors?: readonly Class[];
  readonly excludeToolInterceptors?: readonly Class[];
}

/**
 * The memory an agent or a router reads (#120 PR 3): its own `@Compaction` and how many recent turns
 * it sees in full — single settings, over the workflow's and the application's.
 */
export interface CompactionFields {
  readonly compaction?: Class;
  readonly uncompactedTurns?: UncompactedTurns;
}

/**
 * The PII policies an agent or a router adds to what it inherits (`@Application` → `@Workflow`),
 * and the inherited ones it removes for its own model and tools (#120) — never for logs and traces.
 */
export interface PiiPolicyFields {
  readonly piiPolicies?: readonly Class[];
  readonly excludePiiPolicies?: readonly Class[];
}

/**
 * One agent's settings as assembly reads them (from its `@Agent` options, #272): its model, prompt,
 * tools (class references), knowledge bases, judges and memory.
 */
export interface AgentMeta
  extends GuardrailFields, PiiPolicyFields, CompactionFields, ToolInterceptorFields {
  readonly name: string;
  readonly description: string;
  readonly prompt?: PromptValue;
  readonly promptUrls?: readonly string[];
  readonly model?: string;
  /** The `@ModelProvider` class its model is served from (#1313); left out: its workflow's, its application's. */
  readonly modelProvider?: Class;
  /**
   * This agent's memory strategy (a `BaseMemoryStrategy` subclass from `@agboss/core/memory`,
   * created by the workflow's container); other agents use the built-in one (`uncompactedTurns`,
   * `compaction`).
   */
  readonly memoryStrategy?: Class<BaseMemoryStrategy>;
  /** Overrides the model provider's price table; the provider's own reported cost comes first. */
  readonly price?: AgentSettings["price"];
  readonly thinking?: AgentSettings["thinking"];
  readonly temperature?: number;
  readonly maxTokens?: AgentSettings["maxTokens"];
  /** `{{key}}` in agent prompts is replaced with the value (assembly fails on unknown keys). */
  readonly promptVariables?: Readonly<Record<string, string>>;
  readonly cache?: AgentSettings["cache"];
  /** Tool calls per call of the agent (`agents.<name>.limits.toolCalls`); default 20. */
  readonly maxToolCalls?: number;
  /** `@Tool` classes, and question roles (#712). */
  readonly tools?: readonly AgentToolClass[];
  /** `@Judge` classes. */
  readonly judges?: readonly Class<object>[];
  readonly maxRetries?: number;
  /** Knowledge bases: `{ use: CompanyDocs, mode: RagMode.Tool }` — `mode` is required. */
  readonly rag?: readonly RagBinding[];
  /** Files for the agent's model (#899): the sources, views and limits it opted in to. */
  readonly files?: ModelFiles;
  /** The file the agent is declared in. */
  readonly source?: string;
}

/**
 * The module of a `@Workflow` (#272): what its container, config and policies are built from — its
 * graph is the analysed flow, kept apart. Built once per workflow class (`moduleOf`).
 */
export interface WorkflowMeta {
  readonly name: string;
  readonly version: string;
  /** The file the workflow is declared in. */
  readonly source?: string;
  readonly defaults: AgentsConfig["defaults"];
  readonly piiPolicies?: readonly Class[];
  /** Inherited PII policies removed at the workflow's models (#1150); never for observability. */
  readonly excludePiiPolicies?: readonly Class[];
  /** `@InputGuardrail` / `@OutputGuardrail` classes of every agent and router, over the application's. */
  readonly guardrails?: readonly Class[];
  /** `@ToolInterceptor` classes of every agent's tool calls, over the application's (#384). */
  readonly toolInterceptors?: readonly Class[];
  /** Application-level tool interceptors removed for every agent of the workflow (#1295). */
  readonly excludeToolInterceptors?: readonly Class[];
  /** `@Compaction` of every agent and model router, over the application's (#120 PR 3). */
  readonly compaction?: Class;
  /** Recent turns seen in full by every agent and model router, over the application's. */
  readonly uncompactedTurns?: UncompactedTurns;
  readonly providers?: readonly Provider[];
  /** `@Workflow({ services })` (#1324): scoped to the workflow's own container. */
  readonly services?: readonly Provider[];
  readonly promptVariables?: Readonly<Record<string, string>>;
  /** The workflow's and its application's `modelProvider` (#1313), the levels over a component's own. */
  readonly modelCascade?: ModelCascade;
}
