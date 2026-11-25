import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { TYPESCRIPT_ONLY_KEYS } from "./define-config.js";
import { ScalarOverlaySchema } from "./overlay-schema.js";
import type { ConfigSpec } from "./overlay-types.js";
import { forbiddenProfile, invalidProfile } from "./profile-error.js";

/**
 * A `.config.yaml`: constants only — the same schema as a `defineConfig`, none of its classes, no
 * `${ENV}` (only `defineEnv` reads the process's variables), no switch of a workflow's own feature.
 */

const isPlain = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The path of the first string of a YAML value that reads the process environment (`${NAME}`). */
function interpolationIn(value: unknown, path: string): string | undefined {
  if (typeof value === "string") return /\$\{[^}]*\}/.test(value) ? path : undefined;
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : isPlain(value)
      ? Object.entries(value)
      : [];
  for (const [key, inner] of entries) {
    const found = interpolationIn(inner, path === "" ? key : `${path}.${key}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The features a workflow's own declaration switches on or off: a profile may tune them, never enable one. */
const SWITCHES = ["memory", "filePolicy", "budget", "modelProvider"] as const;

/** The first workflow overlay that names a switch: `workflows.<name>.<switch>`. */
function switchIn(raw: Readonly<Record<string, unknown>>): string | undefined {
  for (const [workflow, overlay] of Object.entries(isPlain(raw.workflows) ? raw.workflows : {})) {
    const key = isPlain(overlay) ? SWITCHES.find((item) => item in overlay) : undefined;
    if (key !== undefined) return `workflows.${workflow}.${key}`;
  }
  return undefined;
}

/** What a YAML profile may not hold, as the sentence of its error; `undefined` when it holds none. */
function forbiddenIn(raw: Readonly<Record<string, unknown>>): string | undefined {
  const typeScriptOnly = TYPESCRIPT_ONLY_KEYS.find((key) => key in raw);
  if (typeScriptOnly !== undefined)
    return `${typeScriptOnly}: only a .config.ts holds it (a YAML file is constants)`;
  const interpolated = interpolationIn(raw, "");
  if (interpolated !== undefined)
    return `${interpolated}: a \${…} reference reads the process environment — only defineEnv does that`;
  const switched = switchIn(raw);
  return switched === undefined
    ? undefined
    : `${switched}: a YAML profile cannot enable or replace it — declare it on the workflow, or use a .config.ts`;
}

/** The mapping a YAML file holds; `undefined` for an empty file. */
function mappingOf(file: string): Readonly<Record<string, unknown>> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, "utf8"));
  } catch {
    throw invalidProfile(file, "is not valid YAML");
  }
  if (raw === null || raw === undefined) return undefined;
  if (!isPlain(raw)) throw invalidProfile(file, "must be a mapping of settings");
  return raw;
}

/** The spec of a `.config.yaml`, checked: forbidden things first, then the schema's path and rule. */
export function yamlSpecOf(file: string): ConfigSpec {
  const raw = mappingOf(file);
  if (raw === undefined) return {};
  const forbidden = forbiddenIn(raw);
  if (forbidden !== undefined) throw forbiddenProfile(file, forbidden);
  const parsed = ScalarOverlaySchema.safeParse(raw);
  if (parsed.success) return parsed.data as ConfigSpec;
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".") ?? "";
  throw invalidProfile(file, `${path === "" ? "" : `${path}: `}${issue?.message ?? "invalid"}`);
}
