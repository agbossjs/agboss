import { z } from "zod";
import { isVariableReference } from "../environments/define-env.js";
import {
  AgentsConfigSchema,
  AgentSettingsSchema,
  CompactionSettingsSchema,
  UncompactedTurnsSchema,
} from "./types.js";
import { Ttl } from "../units/index.js";
import { isExpiresIn } from "../channels/channel-rules.js";

/** Every field optional at every depth; unknown keys rejected (a typo surfaces with its path). */
export function deepPartial(schema: z.ZodType): z.ZodType {
  const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
  if (!(inner instanceof z.ZodObject)) return inner.optional();
  const shape = Object.fromEntries(
    Object.entries(inner.shape as Record<string, z.ZodType>).map(([key, value]) => [
      key,
      deepPartial(value),
    ]),
  );
  return z.strictObject(shape).optional();
}

const defaultsShape = AgentsConfigSchema.shape.defaults;

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;
const kebab = z.string().regex(KEBAB, "lowercase letters, digits and dashes");

/**
 * A prompt override: a string that starts with `./`, `../` or `/` is a file (relative to the profile
 * file), any other string is the text itself; `{ inline }` is a text that starts like a path.
 */
export const PromptOverrideSchema = z.union([
  z.string().min(1),
  z.strictObject({ inline: z.string().min(1) }),
]);

/** A model and the `name` of its provider: what a profile changes of one component's model. */
export const ComponentModelOverlaySchema = z.strictObject({
  model: z.string().min(1).optional(),
  modelProvider: kebab.optional(),
});

/** A `defineEnv` value (`appEnv.dailyBudgetUsd`): a `.config.ts` holds one, a YAML file cannot. */
const envValue = z.custom<unknown>(isVariableReference, "a number or a defineEnv value");

/** The limits a profile gives one `@Budget`: a constant, or a `defineEnv` value in a `.config.ts`. */
export const BudgetOverlaySchema = z
  .strictObject({
    maxSpend: z.union([z.number().positive(), envValue]).optional(),
    maxTokens: z.union([z.number().int().positive(), envValue]).optional(),
  })
  .refine((one) => one.maxSpend !== undefined || one.maxTokens !== undefined, {
    message: "give maxSpend and/or maxTokens",
  });

/** How long something is kept: milliseconds above 0, or `Ttl.Forever` (`"forever"`). */
const keptFor = z.union([z.number().positive(), z.literal(Ttl.Forever)]);

/** What a profile changes of one `@Memory`, by its name: its keep time, its window and its compaction pace. */
export const MemoryOverlaySchema = z
  .strictObject({
    ttl: keptFor.optional(),
    uncompactedTurns: UncompactedTurnsSchema.optional(),
    turnsBetweenCompactions: z.number().int().positive().optional(),
  })
  .refine((one) => Object.keys(one).length > 0, {
    message: "give ttl, uncompactedTurns and/or turnsBetweenCompactions",
  });

/** A deadline or a reminder: a plain duration in milliseconds, or working time (`.config.ts`), at least one second. */
const timeSpan = z.custom<unknown>(isExpiresIn, "a duration of at least one second");

/** What a profile changes of one `@ToolApproval` / `@ExternalTask`, by its name: how long its pauses wait. */
export const PauseTargetOverlaySchema = z
  .strictObject({ timeout: timeSpan.optional(), remindBefore: timeSpan.optional() })
  .refine((one) => one.timeout !== undefined || one.remindBefore !== undefined, {
    message: "give timeout and/or remindBefore",
  });

/** What a profile changes of one `@DatabaseStorage`, by its name: how long its rows are kept. */
export const DatabaseStorageOverlaySchema = z
  .strictObject({
    auditLogTtl: z
      .union([z.number().positive(), z.literal(Ttl.Forever), z.literal(Ttl.None)])
      .optional(),
    ledgerEntriesTtl: keptFor.optional(),
  })
  .refine((one) => Object.keys(one).length > 0, {
    message: "give auditLogTtl and/or ledgerEntriesTtl",
  });

/** What a profile changes of the application's `@Mesh`, by its name. */
export const MeshOverlaySchema = z
  .strictObject({
    deduplicationTtl: z.number().positive().optional(),
    maxHops: z.number().int().positive().optional(),
    envelopeTtl: z.number().positive().optional(),
    maxClockSkew: z.number().nonnegative().optional(),
  })
  .refine((one) => Object.keys(one).length > 0, { message: "give at least one limit" });

/** What a profile changes of one workflow's config: constants only. */
export const WorkflowOverlaySchema = z.strictObject({
  /** The config version a profile's runs carry. */
  version: z.string().min(1).optional(),
  /** A `@Memory`'s compaction settings by its name: its model, turns between compactions, queue. */
  memories: z.record(z.string(), deepPartial(CompactionSettingsSchema)).optional(),
  agents: z.record(z.string(), deepPartial(AgentSettingsSchema)).optional(),
  /** A model router's model and provider by its node name. */
  routers: z.record(z.string(), ComponentModelOverlaySchema).optional(),
  /** Replaces an agent's system instructions. */
  prompts: z.record(z.string(), PromptOverrideSchema).optional(),
});

/** What a profile changes of one `@ModelProvider`, by its name: its model names. */
export const ModelProviderOverlaySchema = z.strictObject({
  /** The model of a component that names none. */
  model: z.string().min(1).optional(),
  /** Role names to the vendor's model names, merged over the provider's own. */
  models: z.record(z.string().min(1), z.string().min(1)).optional(),
});

/**
 * The constant part of a profile — what `src/config/<name>.config.yaml` may hold, and what
 * `defineConfig` checks of a `.config.ts` before its TypeScript-only keys: scalars and plain objects,
 * never a class, a function or a reference to the process environment.
 */
export const ScalarOverlaySchema = z.strictObject({
  /** Chat defaults of every workflow of the application. */
  defaults: deepPartial(defaultsShape),
  modelProviders: z.record(kebab, ModelProviderOverlaySchema).optional(),
  /** The limits of each `@Budget` that declares them, by its name. */
  budgets: z.record(kebab, BudgetOverlaySchema).optional(),
  /** A `@Memory`'s keep time, window and compaction pace by its name. */
  memories: z.record(kebab, MemoryOverlaySchema).optional(),
  /** How long a `@DatabaseStorage` keeps its audit log and ledger entries, by its name. */
  databaseStorages: z.record(kebab, DatabaseStorageOverlaySchema).optional(),
  /** The application's `@Mesh` limits, by its name. */
  mesh: z.record(kebab, MeshOverlaySchema).optional(),
  /** How long the pauses of a `@ToolApproval` wait, by its name. */
  toolApprovals: z.record(kebab, PauseTargetOverlaySchema).optional(),
  /** How long the pauses of an `@ExternalTask` wait, by its name. */
  externalTasks: z.record(kebab, PauseTargetOverlaySchema).optional(),
  judges: z.record(kebab, ComponentModelOverlaySchema).optional(),
  arbiters: z.record(kebab, ComponentModelOverlaySchema).optional(),
  guardrails: z.record(kebab, ComponentModelOverlaySchema).optional(),
  piiPolicies: z.record(kebab, ComponentModelOverlaySchema).optional(),
  channelInterpreters: z.record(kebab, ComponentModelOverlaySchema).optional(),
  /** By workflow name; `"*"` applies to every workflow first. */
  workflows: z.record(z.union([kebab, z.literal("*")]), WorkflowOverlaySchema).optional(),
});
