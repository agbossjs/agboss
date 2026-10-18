/**
 * `env("X")` in an environment file (#261): a field read from a process variable when the app
 * starts. The file is plain data typed by the contract (`export const environment: AppEnvironment =
 * { … }`), so `env` is typed as the value it stands for — a `string`, `number` or `boolean` — and the
 * framework replaces each reference with the variable's value before any component sees it.
 */

/** The type of the value a process variable gives. */
export enum VariableKind {
  Text = "text",
  Integer = "integer",
  Flag = "flag",
}

/** A value the environment file reads from a process variable (resolved at start). */
export class VariableReference {
  constructor(
    readonly variable: string,
    readonly kind: VariableKind,
    readonly fallback: string | number | boolean | undefined,
  ) {}
}

/** `{ default }`: the value when the variable is unset or empty; without it the variable is required. */
export interface EnvironmentValueOptions<TValue> {
  readonly default?: TValue;
}

/** `env("REGION")`, `env.integer("PORT")`, `env.flag("DEBUG")` — each with an optional `{ default }`. */
export interface EnvironmentVariableReader {
  (variable: string, options?: EnvironmentValueOptions<string>): string;
  integer(variable: string, options?: EnvironmentValueOptions<number>): number;
  flag(variable: string, options?: EnvironmentValueOptions<boolean>): boolean;
}

// Each reader is typed as the value it stands for; it returns the reference the start resolves.
function textVariable(variable: string, options?: EnvironmentValueOptions<string>): string;
function textVariable(
  variable: string,
  options: EnvironmentValueOptions<string> = {},
): string | VariableReference {
  return new VariableReference(variable, VariableKind.Text, options.default);
}

function integerVariable(variable: string, options?: EnvironmentValueOptions<number>): number;
function integerVariable(
  variable: string,
  options: EnvironmentValueOptions<number> = {},
): number | VariableReference {
  return new VariableReference(variable, VariableKind.Integer, options.default);
}

function flagVariable(variable: string, options?: EnvironmentValueOptions<boolean>): boolean;
function flagVariable(
  variable: string,
  options: EnvironmentValueOptions<boolean> = {},
): boolean | VariableReference {
  return new VariableReference(variable, VariableKind.Flag, options.default);
}

/** Reads a field of an environment file from a process variable, when the app starts. */
export const env: EnvironmentVariableReader = Object.assign(textVariable, {
  integer: integerVariable,
  flag: flagVariable,
});
