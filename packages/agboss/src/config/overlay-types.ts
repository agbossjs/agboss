import type { ApplicationOptions } from "../application/application.js";
import type { EnvOverrides } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import type { Class } from "../components/injection.js";
import type { ChildPlacement } from "../flow/child-placement.js";
import type { WorkflowExecutionLimits } from "../flow/decorators/workflow.js";
import type { EnvRef } from "../environments/env-ref.js";
import type { Milliseconds, Ttl, Usd } from "../units/index.js";
import type { BudgetOverlay } from "../budgets/budget-overlay.js";
import type { MemoryOverlay } from "../memory/memory.decorator.js";
import type { PauseTargetOverlay } from "../channels/pause-targets.js";
import type { FilePolicyOverlay } from "../files/file-policy.js";
import type { AgentSettings, AgentsConfig, CompactionSettings } from "./settings-types.js";

/** Every field optional at every depth (lists stay whole: a list in a profile replaces the default one). */
export type OverlayPartial<TValue> = TValue extends readonly unknown[]
  ? TValue
  : TValue extends object
    ? { readonly [TKey in keyof TValue]?: OverlayPartial<TValue[TKey]> }
    : TValue;

/** A prompt override: a `./` `../` `/` string is a file next to the profile, any other string the text. */
export type PromptOverride = string | { readonly inline: string };

/** The model of one model-backed component under a profile, as a `.config.yaml` writes it: names only. */
export interface ComponentModelOverlay {
  /** The model the component asks for: a role of its provider, or a vendor's name. */
  readonly model?: string;
  /** The `name` of the `@ModelProvider` that serves it; it must reach the application. */
  readonly modelProvider?: string;
}

/** The model of the built-in file transcriber or redactor of one agent: a model name the gateway serves. */
export interface FileModelOverlay {
  readonly model: string;
}

/** The same in a `.config.ts`: the provider may be its class as well. */
export interface ComponentModelConfig {
  readonly model?: string;
  readonly modelProvider?: string | Class;
}

/** What a profile changes of one `@DatabaseStorage`, by its name: how long its rows are kept. */
export interface DatabaseStorageOverlay {
  readonly auditLogTtl?: Milliseconds | Ttl.Forever | Ttl.None;
  readonly ledgerEntriesTtl?: Milliseconds | Ttl.Forever;
}

/** What a profile changes of one `@Channel`, by its `name`: how long a closed pause is kept, how long a call may run. */
export interface ChannelOverlay {
  /** How long a closed pause of this channel is kept (a channel bound to a pause target only). */
  readonly ttl?: Milliseconds;
  /** How long one call of the channel may run. */
  readonly timeout?: Milliseconds;
}

/** What a profile changes of one `@A2AEndpoint`, by its `name`: how long it keeps what it serves. */
export interface A2AEndpointOverlay {
  /** How long it keeps its tasks and its direct messages\' replies. */
  readonly ttl?: {
    /** A finished task after its last status change. */
    readonly tasks?: Milliseconds | Ttl.Forever;
    /** A direct message's reply, above the execution lease. */
    readonly messages?: Milliseconds;
  };
}

/** What a profile changes of one `@A2AAgent`, by its `name`: its address, origins, call bound and price. */
export interface A2AAgentOverlay {
  /** The agent's base URL; a `defineEnv` value in a `.config.ts`. */
  readonly url?: string | EnvRef<string>;
  /** Origins besides the `url`'s the agent's card may name; replaces the declared list. */
  readonly allowedOrigins?: readonly (string | EnvRef<string>)[];
  /** How long one call waits for the task at most. */
  readonly timeout?: Milliseconds;
  /** What one call costs by contract. */
  readonly costPerCall?: Usd;
}

/** What a profile changes of one `@McpServer`, by its `name`: its bounds, its price and its address. */
export interface McpServerOverlay {
  /** How long one call may run. */
  readonly timeout?: Milliseconds;
  /** What one call costs by contract. */
  readonly costPerCall?: Usd;
  /** At most this many calls at once. */
  readonly maxConcurrentCalls?: number;
  /** An HTTP server's URL; a `defineEnv` value in a `.config.ts`. */
  readonly url?: string | EnvRef<string>;
  /** A stdio server's command. */
  readonly command?: string | EnvRef<string>;
  /** A stdio server's arguments; replaces the declared list. */
  readonly args?: readonly (string | EnvRef<string>)[];
}

/** What a profile changes of the application's `@Mesh`, by its name: its limits and clock tolerance. */
export interface MeshOverlay {
  readonly deduplicationTtl?: Milliseconds;
  readonly maxHops?: number;
  readonly envelopeTtl?: Milliseconds;
  readonly maxClockSkew?: Milliseconds;
}

/** What a profile changes of one workflow (`workflows: { "credit-workflow": { … } }`). */
export interface WorkflowOverlay {
  /** The config version the workflow's runs carry under this profile. */
  readonly version?: string;
  /** Where this workflow runs when another launches it as a child, over its `@Workflow({ placement })` and the application's default. */
  readonly placement?: ChildPlacement;
  /**
   * How long the history of this workflow's finished executions is kept, over its `@Workflow({ historyTtl })`:
   * milliseconds, `Ttl.Forever` or `Ttl.None`.
   */
  readonly historyTtl?: Milliseconds | Ttl;
  /**
   * The workflow's `executionLimits` under this profile, field by field over its `@Workflow({ executionLimits })`
   * (and over an earlier profile's). The run, the assembly rules, the worst case and `describe` read the same values.
   */
  readonly executionLimits?: WorkflowExecutionLimits;
  /** A `@Memory`'s compaction settings by its name. */
  readonly memories?: Readonly<Record<string, OverlayPartial<CompactionSettings>>>;
  /** An agent's settings by its name: model, temperature, thinking, limits. */
  readonly agents?: Readonly<Record<string, OverlayPartial<AgentSettings>>>;
  /** A model router's model and provider by its node name. */
  readonly routers?: Readonly<Record<string, ComponentModelOverlay>>;
  /** An agent's system instructions by its name. */
  readonly prompts?: Readonly<Record<string, PromptOverride>>;
}

/** The workflow's overlay in a `.config.ts`: the constants and the classes that stand in for its own. */
export interface WorkflowConfig extends Omit<WorkflowOverlay, "routers"> {
  /** A model router's model and provider by its node name; the provider may be its class. */
  readonly routers?: Readonly<Record<string, ComponentModelConfig>>;
  /** The `@ModelProvider` this workflow's components resolve to, instead of its own. */
  readonly modelProvider?: Class;
  /** The `@Budget` that caps this workflow's executions, instead of its `@Workflow({ budget })`. */
  readonly budget?: Class;
  /** The `@Memory` of this workflow's agents and routers, instead of its `@Workflow({ memory })`. */
  readonly memory?: Class;
  /** The `@FilePolicy` of this workflow's files, instead of its `@Workflow({ filePolicy })`. */
  readonly filePolicy?: Class;
}

/** What a profile changes of one `@ModelProvider`, by its `name`. */
export interface ModelProviderOverlay {
  /** The model of a component that names none. */
  readonly model?: string;
  /** Role names to the vendor's model names, merged over the provider's own. */
  readonly models?: Readonly<Record<string, string>>;
}

/**
 * One profile, `src/config/<name>.config.ts`: `export default defineConfig({ … })`. Constants overlay what
 * the decorators declare; classes replace the application's own infrastructure. Every secret and
 * variable is a `defineEnv` reference, never an ad-hoc `env.*` call here.
 */
export interface ConfigSpec {
  /** `configureEnv(appEnv, { region: "eu" })`, one per `defineEnv` (a later profile wins per key). */
  readonly env?: EnvOverrides<EnvContract> | readonly EnvOverrides<EnvContract>[];
  /** Chat defaults of every workflow of the application. */
  readonly defaults?: OverlayPartial<AgentsConfig["defaults"]>;
  /** What a profile changes of each `@ModelProvider`, by its `name`. */
  readonly modelProviders?: Readonly<Record<string, ModelProviderOverlay>>;
  /**
   * The limits of each `@Budget` that declares them, by its `name`: `maxSpend` and/or `maxTokens`, a
   * constant or a `defineEnv` value. A budget that reads its limits in `limit()` takes none. Every
   * reader of the budget — the checks, the ledger, the mesh claims, `describe` — sees the same limits.
   */
  readonly budgets?: Readonly<Record<string, BudgetOverlay>>;
  /**
   * What each `@Memory` keeps, by its `name`: `ttl`, `uncompactedTurns` (its window) and
   * `turnsBetweenCompactions`. Every workflow and agent that reads the memory sees the same values: its
   * thread's keep time, its readers' windows, its compaction pace.
   */
  readonly memories?: Readonly<Record<string, MemoryOverlay>>;
  /** How long each `@DatabaseStorage` keeps its audit log and ledger entries, by its `name`. */
  readonly databaseStorages?: Readonly<Record<string, DatabaseStorageOverlay>>;
  /**
   * A `@Mesh` class replaces `@Application({ mesh })`; a record changes the limits of the application's
   * `@Mesh` by its `name`: `deduplicationTtl`, `maxHops`, `envelopeTtl`, `maxClockSkew`. A later profile's
   * record never clobbers an earlier profile's class, nor the other way round. A `.config.yaml` holds only the record.
   */
  readonly mesh?: Class | Readonly<Record<string, MeshOverlay>>;
  /** How long the pauses of each `@ToolApproval` wait (`timeout`, `remindBefore`), by its `name`: the channel, the deadline and the listeners all see it. */
  readonly toolApprovals?: Readonly<Record<string, PauseTargetOverlay>>;
  /** The same for each `@ExternalTask`, by its `name`. */
  readonly externalTasks?: Readonly<Record<string, PauseTargetOverlay>>;
  /**
   * What each `@FilePolicy` allows, by its `name`: `ttl`, `maxFiles`, `maxFileSize`, `maxTotalFileSize`,
   * `allowedMediaTypes`, `allowedOrigins`, `fetchTimeout`, `fetchPool`. A file limit is the same on every
   * path that reads it: A2A files, `Files`, the agents' files, the inline cap, the file expiry.
   */
  readonly filePolicies?: Readonly<Record<string, FilePolicyOverlay>>;
  /** How long each `@A2AEndpoint` keeps its tasks and its direct messages' replies, by its `name`. */
  readonly a2aEndpoints?: Readonly<Record<string, A2AEndpointOverlay>>;
  /** The address, call bound and price of each `@A2AAgent`, by its `name`. */
  readonly a2aAgents?: Readonly<Record<string, A2AAgentOverlay>>;
  /** The bounds, price and address of each `@McpServer`, by its `name`. */
  readonly mcpServers?: Readonly<Record<string, McpServerOverlay>>;
  /** The model the built-in file transcriber reads each agent's transcribed files with, by the agent's `name`. */
  readonly fileTranscribers?: Readonly<Record<string, FileModelOverlay>>;
  /** The model the built-in image redactor hides values with for each agent, by the agent's `name`. */
  readonly fileMaskers?: Readonly<Record<string, FileModelOverlay>>;
  /** The model of each model `@RagReranker` by its `name`. */
  readonly ragRerankers?: Readonly<Record<string, ComponentModelConfig>>;
  /** The model of each `@Judge` by its `name`. */
  readonly judges?: Readonly<Record<string, ComponentModelConfig>>;
  /** The model of each model `@Arbiter` by its `name`. */
  readonly arbiters?: Readonly<Record<string, ComponentModelConfig>>;
  /** The model of each model `@InputGuardrail` / `@OutputGuardrail` by its `name`. */
  readonly guardrails?: Readonly<Record<string, ComponentModelConfig>>;
  /** The model a `@PiiPolicy` detects with, by its `name`. */
  readonly piiPolicies?: Readonly<Record<string, ComponentModelConfig>>;
  /** The model of each model reply interpreter by its `name`. */
  readonly channelInterpreters?: Readonly<Record<string, ComponentModelConfig>>;
  /** By workflow name; `"*"` applies to every workflow first (agents it names that a workflow lacks are skipped). */
  readonly workflows?: Readonly<Record<string, WorkflowConfig>>;
  /** Replaces `@Application({ storage })` whole (the drivers of two storages never deep-merge). */
  readonly storage?: ApplicationOptions["storage"];
  /** Replaces `@Application({ modelProvider })`. */
  readonly modelProvider?: Class;
  /**
   * A list of classes replaces `@Application({ channels })` whole; a record changes the settings of the
   * application's `@Channel`s by their `name` (`ttl`, `timeout`). A `.config.yaml` holds only the record.
   */
  readonly channels?: ApplicationOptions["channels"] | Readonly<Record<string, ChannelOverlay>>;
  /** Replaces `@Application({ healthChecks })`. */
  readonly healthChecks?: ApplicationOptions["healthChecks"];
}
