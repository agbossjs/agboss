import type { ApplicationOptions } from "../application/application.js";
import type { EnvOverrides } from "../environments/define-env.js";
import type { EnvContract } from "../environments/env-ref.js";
import type { Class } from "../components/injection.js";
import type { AgentSettings, AgentsConfig, CompactionSettings } from "./settings-types.js";

/** Every field optional at every depth (lists stay whole: a list in a profile replaces the default one). */
export type OverlayPartial<TValue> = TValue extends readonly unknown[]
  ? TValue
  : TValue extends object
    ? { readonly [TKey in keyof TValue]?: OverlayPartial<TValue[TKey]> }
    : TValue;

/** A prompt override: a `./` `../` `/` string is a file next to the profile, any other string the text. */
export type PromptOverride = string | { readonly inline: string };

/** What a profile changes of one workflow (`workflows: { "credit-workflow": { … } }`). */
export interface WorkflowOverlay {
  /** The config version the workflow's runs carry under this profile. */
  readonly version?: string;
  /** Chat defaults, tools limits and the window of this workflow. */
  readonly defaults?: OverlayPartial<AgentsConfig["defaults"]>;
  /** A compaction's settings by its name. */
  readonly compactions?: Readonly<Record<string, OverlayPartial<CompactionSettings>>>;
  /** An agent's settings by its name: model, temperature, thinking, limits. */
  readonly agents?: Readonly<Record<string, OverlayPartial<AgentSettings>>>;
  /** An agent's system instructions by its name. */
  readonly prompts?: Readonly<Record<string, PromptOverride>>;
}

/** The workflow's overlay in a `.config.ts`: the constants and the classes that stand in for its own. */
export interface WorkflowConfig extends WorkflowOverlay {
  /** The `@ModelProvider` this workflow's components resolve to, instead of its own. */
  readonly modelProvider?: Class;
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
  /** By workflow name; `"*"` applies to every workflow first (agents it names that a workflow lacks are skipped). */
  readonly workflows?: Readonly<Record<string, WorkflowConfig>>;
  /** Replaces `@Application({ storage })` whole (the drivers of two storages never deep-merge). */
  readonly storage?: ApplicationOptions["storage"];
  /** Replaces `@Application({ modelProvider })`. */
  readonly modelProvider?: Class;
  /** Replaces `@Application({ channels })`. */
  readonly channels?: ApplicationOptions["channels"];
  /** Replaces `@Application({ observers })`. */
  readonly observers?: ApplicationOptions["observers"];
  /** Replaces `@Application({ healthChecks })`. */
  readonly healthChecks?: ApplicationOptions["healthChecks"];
}
