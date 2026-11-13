/**
 * The settings types of a workflow's config (#895), written out: what `AgentsConfig`, `AgentSettings`
 * & co. are, no `z.infer` of a schema — so the zod version and the shape of a schema are no part of
 * the public API. `config/types.ts` keeps the schemas internal; tests/config/settings-types.test.ts
 * checks that each pair is the same type, so the two cannot drift.
 */
import type { CompactionStrategy } from "../compaction/compaction.decorator.js";
import type { CachedPart, CacheRetention } from "../models/prompt-caching.js";
import type { ReasoningEffort } from "../models/reasoning.js";
import type { RagMode, RagTenancy, RerankFailurePolicy } from "../rag/types.js";
import type { TokenLimit, TurnLimit } from "./types.js";

/** USD per 1M tokens — take from openrouter.ai/models. Cache prices fall back to input price. */
export interface Price {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number | undefined;
  cacheWritePerMTok?: number | undefined;
}

/** An output ceiling: a whole number of tokens, or `TokenLimit.MODEL_MAX` — what the model allows. */
export type MaxTokens = number | TokenLimit.MODEL_MAX;

/**
 * A component's reasoning: "default" = the model decides, an effort level ("none" = off),
 * `{ budgetTokens }`, or a `Reasoning` value (`@agboss/core/models`).
 */
export type Thinking =
  | "default"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | { budgetTokens: number }
  | { kind: "model-decides" }
  | {
      kind: "on";
      effort?: ReasoningEffort | undefined;
      budget?: { tokens: number } | undefined;
    }
  | { kind: "off" };

/** A component's prompt caching: true = the provider's, false = off, or a `PromptCaching` value. */
export type CacheSetting =
  | boolean
  | {
      kind: "where-supported";
      retention: CacheRetention;
      cachedParts: readonly CachedPart[];
      key?: string | undefined;
    }
  | { kind: "off" };

/** A chat model's settings: its name, and what it overrides of the defaults. */
export interface ModelSettings {
  model: string;
  temperature?: number | undefined;
  maxTokens?: MaxTokens | undefined;
  thinking?: Thinking | undefined;
  cache?: CacheSetting | undefined;
  /** Overrides the provider's price table; the provider's own cost comes first. */
  price?: Price | undefined;
}

/**
 * A `@Compaction` in use, by name: its strategy and — when it writes summaries — its model, how
 * many turns gather before a compaction, and for a queue how many summaries are kept.
 */
export interface CompactionSettings {
  strategy: CompactionStrategy;
  model?: ModelSettings | undefined;
  turnsBetweenCompactions?: number | undefined;
  summaryQueueLength?: number | undefined;
}

/** One agent's settings: its model, tools, judges, knowledge bases and memory. */
export interface AgentSettings extends ModelSettings {
  description: string;
  /** Tool names from the registry. */
  tools?: string[] | undefined;
  /** How many recent turns of the thread the agent sees in full. */
  uncompactedTurns?: number | TurnLimit.ALL | undefined;
  /** Tool calls per call of the agent; crossing it fails the run. */
  maxToolCalls?: number | undefined;
  /** Judges of the agent's reply (names in `judges`), and how often a rejected reply is retried. */
  judges?: string[] | undefined;
  maxRetries?: number | undefined;
  /** Knowledge bases the agent uses: name, mode and passages per retrieval. */
  rag?:
    | {
        name: string;
        mode: RagMode;
        topK: number;
        tenancy: RagTenancy;
        rerank?:
          { reranker: string; candidates: number; onFailure: RerankFailurePolicy } | undefined;
      }[]
    | undefined;
}

/** An MCP server connection. Secrets are never here: only names of env variables. */
export type McpServerConfig =
  | {
      transport: "stdio";
      target?: { application: string; expose: string } | undefined;
      command: string;
      args?: string[] | undefined;
      /** Names of env variables passed to the server process. */
      env?: string[] | undefined;
    }
  | {
      transport: "http";
      target?: { application: string; expose: string } | undefined;
      url: string;
      /** Header name → name of the env variable holding its value. */
      headers?: Record<string, string> | undefined;
    };

/** A workflow's config: its name and version, the defaults, the MCP servers and every agent. */
export interface AgentsConfig {
  /** Agent workflow id: key of the daily spend ledger. */
  name: string;
  /** Readable config version (e.g. 1.3.0) — labels every run. */
  version: string;
  defaults: {
    models: {
      temperature: number;
      maxTokens?: MaxTokens | undefined;
      thinking?: Thinking | undefined;
      cache?: CacheSetting | undefined;
    };
    /** The model of `ROUTER_FACTORY` routers and of eval; none = they need their own. */
    router?: { kind: "jev"; model: string } | (ModelSettings & { kind: "llm" }) | undefined;
    tools?: { maxToolCalls?: number | undefined; maxResultSize?: number | undefined } | undefined;
    /** Recent turns every agent and model router sees in full. */
    uncompactedTurns: number | TurnLimit.ALL;
  };
  mcpServers?: Record<string, McpServerConfig> | undefined;
  /** The `@Compaction`s its agents and model routers use, by name. */
  compactions?: Record<string, CompactionSettings> | undefined;
  /** `@Judge` models by judge name. */
  judges?: Record<string, ModelSettings> | undefined;
  agents: Record<string, AgentSettings>;
}
