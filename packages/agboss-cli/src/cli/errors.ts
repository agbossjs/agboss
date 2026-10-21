import { ComponentError, EnvironmentError, GraphRuleError, WorkflowLoadError } from "agboss";
import { ConfigurationError } from "agboss/models";
import { ApplicationLoadError, ProfileError } from "agboss/internal";
import { ScaffoldConflictError, ScaffoldError, ScaffoldUsageError } from "../scaffold/errors.js";
import { NoTextStartError } from "./text-start.js";

/** What went wrong, as an agent tells it apart: by the exit code (#198). */
export type CliErrorKind = "internal" | "usage" | "project" | "conflict";

/** 0 ok · 1 internal · 2 usage · 3 invalid project · 4 conflict. */
export const EXIT_CODES: Readonly<Record<CliErrorKind, number>> = {
  internal: 1,
  usage: 2,
  project: 3,
  conflict: 4,
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

/** Errors of an invalid project: the application, its workflows or their parts, fixed by editing the project. */
const PROJECT_ERRORS: readonly (readonly [new (...args: never[]) => Error, string])[] = [
  [ApplicationLoadError, "application.load"],
  [WorkflowLoadError, "workflow.load"],
  [GraphRuleError, "graph.rules"],
  [ComponentError, "workflow.assembly"],
  [ConfigurationError, "model.configuration"],
  [ProfileError, "profile.invalid"],
  [NoTextStartError, "workflow.no-text-start"],
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
  if (error instanceof EnvironmentError) return new CliError("project", error.code, error.message);
  const message = error instanceof Error ? error.message : String(error);
  const known = PROJECT_ERRORS.find(([type]) => error instanceof type);
  if (known !== undefined) return new CliError("project", known[1], message);
  return new CliError("internal", "internal", message);
}
