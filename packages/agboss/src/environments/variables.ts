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

/** Reads a variable's text as a typed value (`env.duration`, `env.bytes`, …): `undefined` when it does not parse. */
export type ValueParser = (raw: string) => unknown;

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
    readonly fallback: unknown,
    readonly presence: VariablePresence = VariablePresence.Required,
    /** The reader of a typed variable (#1324): its text as the value; none for text, integer and flag. */
    readonly parser?: ValueParser,
    /** What a value that does not parse is called in the message: `a duration (30d, 24h)`. */
    readonly expected?: string,
  ) {}
}
