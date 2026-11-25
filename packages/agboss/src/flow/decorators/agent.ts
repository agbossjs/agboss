import { recordOptionKeys } from "../../components/option-keys.js";
import { AGENT_KEYS } from "../../components/decorator-options.js";
import type { PromptVariables } from "../../components/prompt-variables.js";
import type { PromptSource } from "../../components/prompt-source.js";
import type { ModelFiles } from "../../files/model-files.js";
import { callerFile } from "../../components/call-site.js";
import { captureCallSite } from "../../core/diagnostics/source-span.js";
import type { Class } from "../../components/injection.js";
import type { AgentToolClass } from "../../components/decorators.js";
import type { CacheSetting, MaxTokens, Price } from "../../config/settings-types.js";
import type { Reasoning } from "../../models/reasoning.js";
import { NodeKind } from "../ast.js";
import type { OutputShape } from "../dto-wrappers.js";
import { declared, recordDeclaration, type InputFields } from "./declaration.js";

/**
 * `@Agent` — the agent options of today plus `input` / `output` (#270) and `executionLimits`; reasoning
 * only as `Reasoning.off()` / `.on({ effort })` / `.modelDecides()` (#269: no `thinking`), no
 * `compensate`. An interface, not a union, so `satisfies Omit<AgentOptions, "name" | "description">`
 * keeps every field for a shared `*.options.ts` const (#272, 2026-10-16).
 */
export interface AgentOptions {
  /** Ends with `-agent` (`draft-reviewer-agent`); explicit, it keys records and checkpoints. */
  readonly name: string;
  readonly description: string;
  readonly prompt?: PromptSource;
  /** Static `{{key}}` values of the prompt (the same bytes in every execution). */
  readonly promptVariables?: PromptVariables;
  /**
   * A model name, or a role the provider maps (`"fast"`, `models` of `@ModelProvider`); left out, the
   * provider's `model`, else its `models.default` (#1313).
   */
  readonly model?: string;
  /**
   * The `@ModelProvider` class this agent's model is served from; left out, its workflow's
   * `modelProvider`, else its application's (#1313).
   */
  readonly modelProvider?: Class;
  /** What the agent reads from the path scope, by type. */
  readonly input?: InputFields;
  /** What it answers with; without it, text. What the answers are about is said in the flow (#299). */
  readonly output?: OutputShape;
  /** The caps of one run of the agent: its visits, model calls, tool calls and judge retries. */
  readonly executionLimits?: AgentExecutionLimits;
  /** `@Tool` classes, and external tasks (`@ExternalTask`, #712): a task has no `execute`. */
  readonly tools?: readonly AgentToolClass[];
  readonly reasoning?: Reasoning;
  /** `@Rag` classes: their passages come with the input, before the first model call (a tool injects a `@Rag` through `deps`). */
  readonly rag?: readonly Class[];
  readonly price?: Price;
  readonly temperature?: number;
  readonly maxTokens?: MaxTokens;
  readonly cache?: CacheSetting;
  /** `@Judge` classes. */
  readonly judges?: readonly Class<object>[];
  /** Guardrails added to the inherited ones (`@Application` → `@Workflow`): `@InputGuardrail` / `@OutputGuardrail` classes. */
  readonly guardrails?: readonly Class[];
  /** Inherited guardrails removed for this agent's own model. */
  readonly excludeGuardrails?: readonly Class[];
  /** PII policies added to the inherited ones; they apply to its model and tools, never to logs and traces. */
  readonly piiPolicies?: readonly Class[];
  /** Inherited PII policies removed for this agent's own model and tools. */
  readonly excludePiiPolicies?: readonly Class[];
  /** Tool interceptors added to the inherited ones, for every call it makes to its tools. */
  readonly toolInterceptors?: readonly Class[];
  /** Inherited tool interceptors removed for this agent. */
  readonly excludeToolInterceptors?: readonly Class[];
  /** Its own `@Memory` class over its workflow's; `NoMemory` sees only the current turn. */
  readonly memory?: Class;
  /** Files for the agent's model (#899): `ModelFiles.of({ sources, views, … })`; without it, no byte goes to the model. */
  readonly files?: ModelFiles;
}

/**
 * What one agent may do (`@Agent({ executionLimits })`): each cap is a whole number from 0, and a cap that is
 * left out is the framework's default (model calls 12, tool calls 20, retries 0) or, for visits, no limit.
 */
export interface AgentExecutionLimits {
  /** Visits per execution; one more fails before the model call (`VisitsLimitExceededError`). */
  readonly maxVisits?: number;
  /** Model calls per run of the agent; crossing it fails the run (`agents.<name>.limits.modelCalls`). Default 12. */
  readonly maxModelCalls?: number;
  /** Tool calls per run of the agent; crossing it fails the run. Default: `defaults.tools.maxToolCalls`, else 20. */
  readonly maxToolCalls?: number;
  /** How often a reply a judge rejected is sent back to the model. Default 0. */
  readonly maxRetries?: number;
}

/**
 * An agent: all declaration, an empty class. The options are recorded as written — with a spread
 * from a shared `*.options.ts` const they keep its exact objects, which the analyser (PR 2) matches
 * against that module's exports for `[agent.dynamic-options]`.
 */
export function Agent(options: AgentOptions) {
  const source = callerFile();
  const span = captureCallSite();
  return <TClass extends Class>(value: TClass): TClass => {
    recordOptionKeys(value, "Agent", options, AGENT_KEYS);
    recordDeclaration(value, declared(NodeKind.Agent, options, source, span));
    return value;
  };
}
