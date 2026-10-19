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

/** Whether a variable must be set: `env("X")` and `env("X", { default })` give a value, `env.optional("X")` may not. */
export enum VariablePresence {
  /** Unset fails the start, unless the reference has a `{ default }`. */
  Required = "required",
  /** Unset is `undefined` (`env.optional("X")`, #266 S90); a set value is still checked. */
  Optional = "optional",
}

/** A value the environment file reads from a process variable (resolved at start). */
export class VariableReference {
  constructor(
    readonly variable: string,
    readonly kind: VariableKind,
    readonly fallback: string | number | boolean | undefined,
    readonly presence: VariablePresence = VariablePresence.Required,
  ) {}
}

/** `{ default }`: the value when the variable is unset or empty; without it the variable is required. */
export interface EnvironmentValueOptions<TValue> {
  readonly default?: TValue;
}

/**
 * One kind of variable: `reader("X")` (required), `reader("X", { default })`, and
 * `reader.optional("X")` — `undefined` when the variable is unset or empty, for an optional field of
 * the contract (`openRouterBaseUrl?: string`); a set value is still checked (#266 S90).
 */
export interface EnvironmentValueReader<TValue> {
  /** The variable's value; unset → its `{ default }`, else the start fails naming it. */
  (variable: string, options?: EnvironmentValueOptions<TValue>): TValue;
  /** The variable's value, or `undefined` when it is unset or empty. */
  optional(variable: string): TValue | undefined;
}

/**
 * `env("REGION")`, `env.integer("PORT")`, `env.flag("DEBUG")` — each with an optional `{ default }`,
 * and each with `.optional("X")`: `env.optional("OPENROUTER_BASE_URL")`, `env.integer.optional("PORT")`.
 */
export interface EnvironmentVariableReader extends EnvironmentValueReader<string> {
  /** An integer variable: `env.integer("PORT")`, `env.integer.optional("PORT")`. */
  readonly integer: EnvironmentValueReader<number>;
  /** A flag variable (true, false, 1, 0): `env.flag("DEBUG")`, `env.flag.optional("DEBUG")`. */
  readonly flag: EnvironmentValueReader<boolean>;
}

// Each reader is typed as the value it stands for; it returns the reference the start resolves.
function textVariable(variable: string, options?: EnvironmentValueOptions<string>): string;
function textVariable(
  variable: string,
  options: EnvironmentValueOptions<string> = {},
): string | VariableReference {
  return new VariableReference(variable, VariableKind.Text, options.default);
}

function optionalText(variable: string): string | undefined;
function optionalText(variable: string): string | VariableReference | undefined {
  return new VariableReference(variable, VariableKind.Text, undefined, VariablePresence.Optional);
}

function integerVariable(variable: string, options?: EnvironmentValueOptions<number>): number;
function integerVariable(
  variable: string,
  options: EnvironmentValueOptions<number> = {},
): number | VariableReference {
  return new VariableReference(variable, VariableKind.Integer, options.default);
}

function optionalInteger(variable: string): number | undefined;
function optionalInteger(variable: string): number | VariableReference | undefined {
  return new VariableReference(
    variable,
    VariableKind.Integer,
    undefined,
    VariablePresence.Optional,
  );
}

function flagVariable(variable: string, options?: EnvironmentValueOptions<boolean>): boolean;
function flagVariable(
  variable: string,
  options: EnvironmentValueOptions<boolean> = {},
): boolean | VariableReference {
  return new VariableReference(variable, VariableKind.Flag, options.default);
}

function optionalFlag(variable: string): boolean | undefined;
function optionalFlag(variable: string): boolean | VariableReference | undefined {
  return new VariableReference(variable, VariableKind.Flag, undefined, VariablePresence.Optional);
}

/** Reads a field of an environment file from a process variable, when the app starts. */
export const env: EnvironmentVariableReader = Object.assign(textVariable, {
  optional: optionalText,
  integer: Object.assign(integerVariable, { optional: optionalInteger }),
  flag: Object.assign(flagVariable, { optional: optionalFlag }),
});
