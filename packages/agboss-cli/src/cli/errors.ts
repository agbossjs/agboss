import {
  ConfigError,
  keyTextRuleOf,
} from "@agboss/core";
import { ProfileError } from "@agboss/core/internal";
import { ScaffoldConflictError, ScaffoldError, ScaffoldUsageError } from "../scaffold/errors.js";
import { NoTextStartError } from "./text-start.js";

/** What went wrong, as an agent tells it apart: by the exit code (#198). */
export type CliErrorKind = "internal" | "usage" | "project" | "conflict" | "quality";

/**
 * 0 ok · 1 internal · 2 usage · 3 invalid project · 4 conflict · 5 quality (#396: an eval case
 * regressed against its baseline — the agent got worse, the project still loads).
 */
export const EXIT_CODES: Readonly<Record<CliErrorKind, number>> = {
  internal: 1,
  usage: 2,
  project: 3,
  conflict: 4,
  quality: 5,
};

/** A failure the CLI reports in one line (and in the JSON envelope as `error: { code, message }`). */
export class CliError extends Error {
  override name = "CliError";
  constructor(
    readonly kind: CliErrorKind,
    /** A stable code, e.g. `usage.unknown-option`, `workflow.not-found`. */
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Unknown flag, missing value or required option: names it and points to the command's help. */
export const usageError = (command: string, code: string, message: string): CliError =>
  new CliError("usage", code, `${message} — see agboss help ${command}`);

/**
 * A `--scope <id>` as given, once it is a key's text: else a usage error naming the rule, never the
 * id — a scope id no source can have would read nothing, silently.
 */
export function scopeOptionOf(command: string, scope: string | undefined): string | undefined {
  const rule = scope === undefined ? undefined : keyTextRuleOf(scope);
  if (rule === undefined) return scope;
  throw usageError(
    command,
    "usage.option-value",
    `option --scope needs a scope id, and a scope id is a key's text: this one breaks ${rule}`,
  );
}

/**
 * A `--tenant <id>` as given, once it is a key's text (#580, the rules of #552): else a usage error
 * naming the rule, never the id — a tenant id no tenant can have would read nothing, silently.
 */
export function tenantOptionOf(command: string, tenant: string | undefined): string | undefined {
  const rule = tenant === undefined ? undefined : keyTextRuleOf(tenant);
  if (rule === undefined) return tenant;
  throw usageError(
    command,
    "usage.option-value",
    `option --tenant needs a tenant id, and a tenant id is a key's text: this one breaks ${rule}`,
  );
}

/** Errors of an invalid project: the application, its workflows or their parts, fixed by editing the project. */
const PROJECT_ERRORS: readonly (readonly [new (...args: never[]) => Error, string])[] = [
  [ConfigError.ApplicationLoad, "application.load"],
  [ConfigError.WorkflowLoad, "workflow.load"],
  [ConfigError.GraphRules, "graph.rules"],
  [ConfigError.Component, "workflow.assembly"],
  [ConfigError.Prompt, "workflow.assembly"],
  [ConfigError.NoDefaultRouter, "workflow.assembly"],
  [ConfigError.ModelSettings, "model.configuration"],
  [ProfileError, "profile.invalid"],
  [NoTextStartError, "workflow.no-text-start"],
  [ConfigError.EvalCase, "eval.case-invalid"],
];

function scaffoldError(error: ScaffoldError): CliError {
  if (error instanceof ScaffoldConflictError)
    return new CliError("conflict", "scaffold.conflict", error.message);
  if (error instanceof ScaffoldUsageError)
    return new CliError("usage", "scaffold.usage", error.message);
  return new CliError("project", "scaffold.project", error.message);
}

/** Any thrown value → a CliError with its kind; anything unrecognised is internal (exit 1). */
export function cliErrorOf(error: unknown): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof ScaffoldError) return scaffoldError(error);
  if (error instanceof ConfigError.Environment) return new CliError("project", error.envCode ?? error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  const known = PROJECT_ERRORS.find(([type]) => error instanceof type);
  if (known !== undefined) return new CliError("project", known[1], message);
  return new CliError("internal", "internal", message);
}
