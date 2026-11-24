import { z } from "zod";
import { AgentsConfigSchema, AgentSettingsSchema, CompactionSettingsSchema } from "./types.js";

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

/** What a profile changes of one workflow's config: constants only. */
export const WorkflowOverlaySchema = z.strictObject({
  /** The config version a profile's runs carry. */
  version: z.string().min(1).optional(),
  defaults: deepPartial(defaultsShape),
  /** A compaction's settings by its name: its model, turns between compactions, queue. */
  compactions: z.record(z.string(), deepPartial(CompactionSettingsSchema)).optional(),
  agents: z.record(z.string(), deepPartial(AgentSettingsSchema)).optional(),
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
  /** By workflow name; `"*"` applies to every workflow first. */
  workflows: z.record(z.union([kebab, z.literal("*")]), WorkflowOverlaySchema).optional(),
});
