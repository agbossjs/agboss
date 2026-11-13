import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { AgentsConfigSchema, AgentSettingsSchema, CompactionSettingsSchema } from "./types.js";
import { normalisePromptText } from "../components/prompt-render.js";
import { AGBossError, type MessageErrorOptions } from "../core/errors.js";

/** A profile names a variant of a workflow and lists only what differs (Spring-Boot-like). */
export class ProfileError extends AGBossError {
  static override readonly code = "config.profile" as const;
  declare readonly code: typeof ProfileError.code;
  override name = "ProfileError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** Every field optional at every depth; unknown keys rejected (typos surface with their path). */
function deepPartial(schema: z.ZodType): z.ZodType {
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
const PromptOverride = z.union([z.string().min(1), z.strictObject({ file: z.string().min(1) })]);

/** `profiles/<workflow>/<profile>.yaml` — validated; JSON Schema in schema/profile.schema.json. */
export const ProfileSchema = z.strictObject({
  profile: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  /** Must differ from the base version, e.g. 1.3.0-low-thinking. */
  version: z.string().min(1),
  defaults: deepPartial(defaultsShape),
  /** A compaction's settings by its name (#120 PR 3): its model, turns between compactions, queue. */
  compactions: z.record(z.string(), deepPartial(CompactionSettingsSchema)).optional(),
  agents: z.record(z.string(), deepPartial(AgentSettingsSchema)).optional(),
  /** Replaces an agent's system instructions: inline text or a file relative to the profile. */
  prompts: z.record(z.string(), PromptOverride).optional(),
});

export type Profile = z.infer<typeof ProfileSchema>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Objects merge key by key; arrays and scalars replace. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override))
    return override === undefined ? base : override;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) merged[key] = deepMerge(base[key], value);
  return merged;
}

/** The profiles of a workflow (the `*.yaml` files of its directory) and `base`, sorted. */
async function availableProfiles(directory: string): Promise<string[]> {
  const files = await readdir(directory).catch(() => [] as string[]);
  const names = files.filter((name) => extname(name) === ".yaml").map((n) => basename(n, ".yaml"));
  return ["base", ...names.filter((name) => name !== "base")].sort();
}

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** The file's text; a profile that does not exist is a `ProfileError` listing the ones that do (#895). */
async function profileText(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    const available = await availableProfiles(dirname(file));
    throw new ProfileError({
      message: `${file}: no profile "${basename(file, ".yaml")}" — available: ${available.join(", ")}`,
      cause: error,
    });
  }
}

/** Reads and validates a profile file; errors name the file and the key. */
export async function loadProfile(file: string): Promise<Profile> {
  const raw: unknown = parseYaml(await profileText(file));
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path.join(".") ?? "";
    throw new ProfileError({
      message: `${file}: ${key === "" ? "" : `${key}: `}${issue?.message ?? "invalid profile"}`,
    });
  }
  return parsed.data;
}

export const profileFile = (root: string, bundle: string, profile: string): string =>
  join(root, "profiles", bundle, `${profile}.yaml`);

/** Prompt overrides as text: inline strings, or files relative to the profile file. */
export async function profilePrompts(
  profile: Profile,
  file: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(profile.prompts ?? {}).map(async ([agent, prompt]) => [
      agent,
      // sent and fingerprinted as an assembled prompt is (#120): normalised
      normalisePromptText(
        typeof prompt === "string"
          ? prompt
          : await readFile(resolve(dirname(file), prompt.file), "utf8"),
      ),
    ]),
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

/** JSON Schema of profiles (for `# yaml-language-server: $schema=…`); lazy parts become open. */
export const profileJsonSchema = (): Record<string, unknown> =>
  z.toJSONSchema(ProfileSchema, { unrepresentable: "any", io: "input" });
