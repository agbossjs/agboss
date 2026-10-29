import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { textOption, type CommandContext } from "./context.js";
import { CliError, usageError } from "./errors.js";
import type { SkillsProject } from "../skills/sync.js";

/**
 * Where the application is (#268 AC1): set once in the project's `package.json` —
 * `"agboss": { "application": "src/job-scout.application.ts" }` — or given with
 * `--application <path>`, which wins. Neither → an error saying where to set it. The path is
 * relative to the folder of the `package.json` that sets it, or to the working directory for
 * `--application`.
 */

/** The application module a command works on: where it is and how to name it in messages. */
export interface ApplicationPath {
  /** The absolute path of the module. */
  readonly file: string;
  /** The path as it was set (`src/job-scout.application.ts`), for messages and problems. */
  readonly shown: string;
}

/** The `agboss` field of a `package.json`, as far as the CLI reads it. */
interface AgbossField {
  readonly application?: unknown;
  /** `false` turns the project skills' sync off (#305). */
  readonly skills?: unknown;
}

const SET_IT_HERE =
  'set "agboss": { "application": "src/<name>.application.ts" } in package.json, or pass --application <path>';

/** The nearest `package.json` from the working directory up; undefined when there is none. */
function packageJsonFrom(cwd: string): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

/** The `agboss` field of a package.json; a file that is not JSON is the project's to fix. */
function agbossFieldOf(file: string): AgbossField | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { readonly agboss?: AgbossField };
    return parsed.agboss;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError("project", "application.package-json", `${file}: ${reason}`);
  }
}

/** `"agboss": { "application": … }` of the nearest package.json; undefined when it is not set. */
function fromPackageJson(cwd: string): ApplicationPath | undefined {
  const packageJson = packageJsonFrom(cwd);
  if (packageJson === undefined) return undefined;
  const value = agbossFieldOf(packageJson)?.application;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "")
    throw new CliError(
      "project",
      "application.path-invalid",
      `${packageJson}: "agboss": { "application" } must be the path of the application module, e.g. "src/<name>.application.ts"`,
    );
  const file = resolve(dirname(packageJson), value);
  if (!existsSync(file))
    throw new CliError(
      "project",
      "application.not-found",
      `Application file not found: ${file} (set in ${packageJson} as "agboss": { "application": "${value}" })`,
    );
  return { file, shown: value };
}

/**
 * The application the project's `package.json` sets (#468), whatever `--application` says; undefined
 * when it sets none.
 */
export function configuredApplicationOf(cwd: string): ApplicationPath | undefined {
  return fromPackageJson(cwd);
}

/** `--application <path>`, else the project's package.json; neither → where to set it. */
export function applicationPathOf(context: CommandContext): ApplicationPath {
  const given = textOption(context.values, "application");
  if (given !== undefined) {
    const file = resolve(context.io.cwd, given);
    if (!existsSync(file))
      throw usageError(
        context.command,
        "application.not-found",
        `Application file not found: ${file} (--application ${given})`,
      );
    return { file, shown: given };
  }
  const configured = fromPackageJson(context.io.cwd);
  if (configured !== undefined) return configured;
  throw new CliError("project", "application.path-not-set", `No application: ${SET_IT_HERE}`);
}

/**
 * The project whose skills `agboss check` and `agboss generate` sync (#305): the folder of the
 * nearest package.json with an `"agboss"` field; `"agboss": { "skills": false }` turns it off.
 * Undefined outside such a project (a package.json without the field is not an AGBoss project's).
 */
export function skillsProjectOf(cwd: string): SkillsProject | undefined {
  const packageJson = packageJsonFrom(cwd);
  if (packageJson === undefined) return undefined;
  const field = agbossFieldOf(packageJson);
  if (field === undefined) return undefined;
  if (field.skills !== undefined && typeof field.skills !== "boolean")
    throw new CliError(
      "project",
      "skills.setting-invalid",
      `${packageJson}: "agboss": { "skills" } must be true or false`,
    );
  return { root: dirname(packageJson), isEnabled: field.skills !== false };
}
