import { AgentFilesSchema } from "../files/files-schema.js";
import type { PromptInput } from "../components/prompt-input.js";
import type { AgentSettings, AgentsConfig, MaxTokens } from "./settings-types.js";
import type { ModelPrice } from "../models/cost.js";

import { z } from "zod";
import { ReasoningEffort, type Reasoning } from "../models/reasoning.js";
import { RagScope, RerankFailurePolicy } from "../rag/types.js";
import { CachedPart, CacheRetention, type PromptCaching } from "../models/prompt-caching.js";
import { CompactionStrategy, CUSTOM_COMPACTION } from "../memory/memory.decorator.js";

/** Limits without a number (#120 S132): enums, next to each other — one spelling per value. */

/** A token limit: `TokenLimit.ModelMax` — no ceiling of our own, what the model allows. */
export enum TokenLimit {
  ModelMax = "max",
}

/** A window without a limit: `uncompactedTurns: TurnLimit.All` — every turn of the thread in full. */
export enum TurnLimit {
  All = "all",
}

/** OpenRouter `reasoning.effort` levels. "none" disables thinking (not accepted by every model). */
export const THINKING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;

export const MaxTokensSchema = z.union([
  z.number().int().positive(),
  z.literal(TokenLimit.ModelMax),
]);

/** A `Reasoning` value (`@agboss/core/models`): `Reasoning.on({ effort, budget })`, `off()`, `modelDecides()`. */
export const ReasoningValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("model-decides") }),
  z.object({
    kind: z.literal("on"),
    effort: z.enum(ReasoningEffort).optional(),
    budget: z.object({ tokens: z.number().int().positive() }).optional(),
  }),
  z.object({ kind: z.literal("off") }),
]);

/**
 * A component's reasoning until #152 brings `reasoning` to the decorators: "default" = the model
 * decides, an effort level ("none" = off), `{ budgetTokens }`, or a `Reasoning` value.
 */
export const ThinkingSchema = z.union([
  z.literal("default"),
  z.enum(THINKING_EFFORTS),
  z.object({ budgetTokens: z.number().int().positive() }),
  ReasoningValueSchema,
]);

/** A `PromptCaching` value (`@agboss/core/models`). */
export const PromptCachingValueSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("on"),
    retention: z.enum(CacheRetention),
    cachedParts: z.array(z.enum(CachedPart)).min(1).readonly(),
    key: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("off") }),
]);

/** A component's prompt caching until #152: true = the provider's, false = off, or a `PromptCaching`. */
export const CacheSettingSchema = z.union([z.boolean(), PromptCachingValueSchema]);

/** Output ceiling when a workflow sets none — a model stuck in a loop stops here. `TokenLimit.ModelMax` = no ceiling. */
export const DEFAULT_MAX_TOKENS = 8192;

/**
 * Defaults for every chat model (agents and LLM routers). Reasoning and caching default to the
 * model provider's (`@ModelProvider`); timeouts, retries and request fields live on the provider.
 */
export const ChatDefaultsSchema = z.object({
  temperature: z.number().min(0).max(2),
  /** Default 8 192 (`DEFAULT_MAX_TOKENS`); `TokenLimit.ModelMax` for no ceiling. */
  maxTokens: MaxTokensSchema.optional(),
  thinking: ThinkingSchema.optional(),
  cache: CacheSettingSchema.optional(),
});

export const ModelSettingsSchema = z.object({
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: MaxTokensSchema.optional(),
  thinking: ThinkingSchema.optional(),
  cache: CacheSettingSchema.optional(),
  /**
   * The `@ModelProvider` this model is served from, by its `name` (#1313): the component's own, else
   * its workflow's, else its application's. Absent: the older providers' `serves` patterns decide.
   */
  modelProvider: z.string().min(1).optional(),
  /**
   * The provider has no `cost` (#1313): a call with no reported cost and no price is recorded
   * `CostSource.Unpriced` at 0 USD, its tokens counted — set by the cascade, never by hand.
   */
  unpriced: z.literal(true).optional(),
});

/** How many recent turns a reader sees in full: a whole number from 0, or `TurnLimit.All`. */
export const UncompactedTurnsSchema = z.union([
  z.number().int().nonnegative(),
  z.literal(TurnLimit.All),
]);

/**
 * A `@Memory` that compacts (#1303), by name: its strategy (`custom`: its class's `compact()`) and — when it writes summaries — its
 * model (`maxTokens` = its `summaryMaxTokens`), how many turns gather before a compaction, and for
 * a queue how many summaries are kept. A profile may change any of them.
 */
export const CompactionSettingsSchema = z.object({
  strategy: z.union([z.enum(CompactionStrategy), z.literal(CUSTOM_COMPACTION)]),
  model: ModelSettingsSchema.optional(),
  turnsBetweenCompactions: z.number().int().positive().optional(),
  summaryQueueLength: z.number().int().positive().optional(),
});

export const AgentSettingsSchema = ModelSettingsSchema.extend({
  /** Files for the agent's model (#899), resolved over its workflow's and application's defaults. */
  files: AgentFilesSchema.optional(),
  description: z.string().min(1),
  /** Tool names from the registry (src/tools/catalog.ts). */
  tools: z.array(z.string()).optional(),
  /** How many recent turns of the thread the agent sees in full; default `defaults.uncompactedTurns`. */
  uncompactedTurns: UncompactedTurnsSchema.optional(),
  /** Model calls per call of the agent; crossing it fails the run. Default 12. */
  maxModelCalls: z.number().int().nonnegative().optional(),
  /** Tool calls per call of the agent; crossing it fails the run. Default: defaults.tools.maxToolCalls, else 20. */
  maxToolCalls: z.number().int().nonnegative().optional(),
  /** Judges of the agent's reply (names in `judges`), and how often a rejected reply is retried (default 0). */
  judges: z.array(z.string()).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  /** Knowledge bases the agent uses (from `@Agent({ rag })`): name, scope and passages per retrieval. */
  rag: z
    .array(
      z.object({
        name: z.string(),
        topK: z.number().int().positive(),
        /** Whose content it serves. */
        scope: z.enum(RagScope),
        /** Reranked: its `@RagReranker`, the candidates fetched, what a failure does. */
        rerank: z
          .object({
            reranker: z.string(),
            candidates: z.number().int().positive(),
            onFailure: z.enum(RerankFailurePolicy),
          })
          .optional(),
      }),
    )
    .optional(),
});

/** Jev (TypeSafe) via OpenRouter Decisions API: probabilities over options, exact cost. */
export const JevRouterModelSchema = z.object({
  kind: z.literal("jev"),
  model: z.string().min(1),
  modelProvider: z.string().min(1).optional(),
});

/** A chat model asked to reply with JSON. */
export const LlmRouterModelSchema = ModelSettingsSchema.extend({ kind: z.literal("llm") });

export const RouterModelSchema = z.discriminatedUnion("kind", [
  JevRouterModelSchema,
  LlmRouterModelSchema,
]);

export const AgentsConfigSchema = z.object({
  /** Agent workflow id: key of the daily spend ledger. */
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  /** Readable config version (e.g. 1.3.0) — labels every run; profiles set their own. */
  version: z.string().min(1),
  defaults: z.object({
    models: ChatDefaultsSchema,
    /** The model of `ROUTER_FACTORY` routers and of eval; none = they need their own. */
    router: RouterModelSchema.optional(),
    /**
     * Tool calls per call of an agent (`agents.<name>.limits.toolCalls`); default 20. What a model
     * reads of one tool result at most, in bytes (#336); default 128 KB.
     */
    tools: z
      .object({
        maxToolCalls: z.number().int().nonnegative().optional(),
        maxResultSize: z.number().int().positive().optional(),
      })
      .optional(),
    /** Recent turns every agent and model router sees in full (workflow over application; 5). */
    uncompactedTurns: UncompactedTurnsSchema,
  }),
  /** The `@Compaction`s its agents and model routers use, by name (#120 PR 3). */
  memories: z.record(z.string(), CompactionSettingsSchema).optional(),
  /** `@Judge` models by judge name. */
  judges: z.record(z.string(), ModelSettingsSchema).optional(),
  agents: z.record(z.string(), AgentSettingsSchema),
});

export type ChatDefaults = z.infer<typeof ChatDefaultsSchema>;
export type RouterModel = z.infer<typeof RouterModelSchema>;
export type {
  AgentSettings,
  AgentsConfig,
  CacheSetting,
  CompactionSettings,
  MaxTokens,
  ModelSettings,
  Thinking,
} from "./settings-types.js";

/** An agent whose tool names are a literal union — a typo does not compile. */
export type AgentSettingsOf<TTool extends string> = Omit<AgentSettings, "tools"> & {
  readonly tools?: readonly TTool[];
};

/** Config with literal agent and tool names — the compiler checks prompts, routing and tools. */
export type AgentsConfigOf<TName extends string, TTool extends string = string> = Omit<
  AgentsConfig,
  "agents"
> & {
  readonly agents: Readonly<Record<TName, AgentSettingsOf<TTool>>>;
};

export class UnknownAgentToolError extends Error {
  override name = "UnknownAgentToolError";
}

/** One system prompt per configured agent; a missing prompt is a compile error. */
export type AgentPrompts<TName extends string> = Readonly<Record<TName, PromptInput>>;

/**
 * Chat model settings after defaults are applied — what a model provider receives. Reasoning and
 * caching left unset are the provider's own.
 */
export interface ResolvedModelSettings {
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: MaxTokens;
  readonly reasoning?: Reasoning | undefined;
  readonly promptCaching?: PromptCaching | undefined;
  /** The provider's price table entry for the model; none = the provider reports the cost. */
  readonly price?: ModelPrice | undefined;
  /** The provider's `name` its cascade resolved (#1313); absent = by `serves`. */
  readonly modelProvider?: string | undefined;
  /** The provider has no `cost`: a call it leaves unpriced is `CostSource.Unpriced` (#1313). */
  readonly unpriced?: true | undefined;
}

/** Validates at startup and keeps the literal type of the config; checks tool names if given. */
export function validateAgentsConfig<TConfig extends AgentsConfigOf<string>>(
  config: TConfig,
  knownTools?: readonly string[],
): TConfig {
  AgentsConfigSchema.parse(config);
  const unknown = Object.entries(config.agents).flatMap(([agent, settings]) =>
    (settings.tools ?? [])
      .filter((tool) => knownTools !== undefined && !knownTools.includes(tool))
      .map((tool) => `${agent} → ${tool}`),
  );
  if (unknown.length > 0) throw new UnknownAgentToolError(`Unknown tools: ${unknown.join(", ")}`);
  return config;
}
