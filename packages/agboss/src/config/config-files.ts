import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { normalisePromptText } from "../components/prompt-render.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { isConfigOverlay } from "./define-config.js";
import type { ConfigSpec, PromptOverride } from "./overlay-types.js";
import { invalidProfile as invalid, ProfileError, ProfileErrorReason } from "./profile-error.js";
import { BASE_PROFILE, type SelectedProfiles } from "./profile-names.js";

/**
 * Where an application's profiles are: `src/config/` next to the file `@Application` is declared in
 * (never `process.cwd()`), one `<name>.config.ts` or `<name>.config.yaml` per profile. `base` is the
 * shared layer every selection starts from, when it exists.
 */

/** The file kinds of a profile, in the order their names are listed. */
export enum ConfigFileKind {
  TypeScript = "ts",
  Yaml = "yaml",
}

/** One file of the config directory. */
export interface ConfigFile {
  readonly name: string;
  readonly file: string;
  readonly kind: ConfigFileKind;
}

/** One profile as loaded: its spec, and the texts its prompt overrides name or hold. */
export interface LoadedProfile {
  readonly name: string;
  readonly file: string;
  readonly spec: ConfigSpec;
  /** `workflows.<workflow>.prompts.<agent>`, as the text an agent is sent. */
  readonly promptTexts: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const FILE = /^(.+)\.config\.(ts|mts|js|mjs|yaml)$/;

/** The folder of an application's profiles. */
export const configDirOf = (source: string): string => join(dirname(source), "config");

const kindOf = (extension: string): ConfigFileKind =>
  extension === "yaml" ? ConfigFileKind.Yaml : ConfigFileKind.TypeScript;

/** The profile files of a folder, sorted by name; two files for one name fail closed. */
export function configFilesOf(dir: string): readonly ConfigFile[] {
  if (!existsSync(dir)) return [];
  const found = readdirSync(dir).flatMap((entry) => {
    const matched = FILE.exec(entry);
    if (matched === null) return [];
    const [, name, extension] = matched;
    if (name === undefined || extension === undefined || name.endsWith(".d")) return [];
    return [{ name, file: join(dir, entry), kind: kindOf(extension) }];
  });
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** The one file of a profile; `undefined` when none; two files for one name are `Duplicate`. */
export function configFileOf(files: readonly ConfigFile[], name: string): ConfigFile | undefined {
  const named = files.filter((file) => file.name === name);
  const [first, second] = named;
  if (second !== undefined && first !== undefined)
    throw new ProfileError({
      reason: ProfileErrorReason.Duplicate,
      message: `profile "${name}" has two files: ${first.file} and ${second.file} — keep one`,
    });
  return first;
}

/** What the folder has: the names the error of an unknown profile lists. */
export const availableProfiles = (files: readonly ConfigFile[]): string[] => [
  ...new Set(files.map((file) => file.name)),
];

type Module = Readonly<Record<string, unknown>>;

const importModule = async (file: string): Promise<Module> =>
  (await lazyLoad(import(pathToFileURL(file).href))) as Module;

/** The spec a `.config.ts` exports by default (`export default defineConfig({ … })`). */
async function typeScriptSpecOf(file: string): Promise<ConfigSpec> {
  let module: Module;
  try {
    module = await importModule(file);
  } catch (error) {
    if (error instanceof ProfileError)
      throw invalid(file, error.message.replace(/^defineConfig: ?/, ""));
    throw error;
  }
  const exported = module.default;
  if (!isConfigOverlay(exported)) throw invalid(file, "must export default defineConfig({ … })");
  return exported;
}

const FILE_PATH = /^(\.{1,2}\/|\/)/;

/** One prompt override as the text an agent is sent: a path's file (next to the profile), or the text. */
function promptTextOf(file: string, override: PromptOverride): string {
  if (typeof override !== "string") return normalisePromptText(override.inline);
  if (!FILE_PATH.test(override)) return normalisePromptText(override);
  const path = resolve(dirname(file), override);
  try {
    return normalisePromptText(readFileSync(path, "utf8"));
  } catch {
    throw invalid(file, `prompt file ${path} cannot be read`);
  }
}

/** The prompt overrides of a spec as texts, by workflow and agent. */
function promptTextsOf(file: string, spec: ConfigSpec): LoadedProfile["promptTexts"] {
  return Object.fromEntries(
    Object.entries(spec.workflows ?? {}).map(([workflow, overlay]) => [
      workflow,
      Object.fromEntries(
        Object.entries(overlay.prompts ?? {}).map(([agent, prompt]) => [
          agent,
          promptTextOf(file, prompt),
        ]),
      ),
    ]),
  );
}

/** One profile file read and checked. */
export async function loadedProfileOf(entry: ConfigFile): Promise<LoadedProfile> {
  const spec =
    entry.kind === ConfigFileKind.Yaml
      ? // the YAML parser (72 modules) loads with the first .config.yaml, not with the root entry
        (await import("./yaml-profile.js")).yamlSpecOf(entry.file)
      : await typeScriptSpecOf(entry.file);
  return { name: entry.name, file: entry.file, spec, promptTexts: promptTextsOf(entry.file, spec) };
}

const unknownProfile = (dir: string, name: string, files: readonly ConfigFile[]): ProfileError => {
  const available = availableProfiles(files);
  return new ProfileError({
    reason: ProfileErrorReason.Unknown,
    message: `no profile "${name}" in ${dir} — available: ${available.length === 0 ? "none" : available.join(", ")}`,
  });
};

/**
 * The profiles a selection layers, `base` first when it exists: the files of `src/config/` next to the
 * application file. A profile that was named and has no file is `Unknown`; the default (`dev`, `test`)
 * with no file is no layer — an application need not have one.
 */
export async function loadProfiles(
  source: string | undefined,
  selected: SelectedProfiles,
): Promise<readonly LoadedProfile[]> {
  const names = selected.names.filter((name) => name !== BASE_PROFILE);
  if (source === undefined) {
    if (!selected.isExplicit) return [];
    throw new ProfileError({
      reason: ProfileErrorReason.Unknown,
      message: `no profile "${names[0] ?? BASE_PROFILE}": where the application is declared is unknown, so is its src/config/`,
    });
  }
  const dir = configDirOf(source);
  const files = configFilesOf(dir);
  const layers: ConfigFile[] = [];
  const base = configFileOf(files, BASE_PROFILE);
  if (base !== undefined) layers.push(base);
  for (const name of names) {
    const found = configFileOf(files, name);
    if (found !== undefined) layers.push(found);
    else if (selected.isExplicit) throw unknownProfile(dir, name, files);
  }
  return Promise.all(layers.map(loadedProfileOf));
}
