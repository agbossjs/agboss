import { type Bytes, type Milliseconds, type Ttl, type Usd } from "../units/index.js";
import type { EnvRef } from "./env-ref.js";
import { bytesOf, durationOf, numberOf, ttlOf, usdOf } from "./env-values.js";
import {
  VariableKind,
  VariablePresence,
  VariableReference,
  type ValueParser,
} from "./variables.js";

/** `{ default }`: the value when the variable is unset or empty; without it the variable is required. */
export interface EnvOptions<TValue> {
  readonly default?: TValue;
}

/** What a reader gives: `TValue` for an old environment file, and the `EnvRef` `defineEnv` reads. */
export type EnvValue<TValue, TPlain> = TPlain & EnvRef<TValue>;

/**
 * One reader of `env`: `reader("X")` (required), `reader("X", { default })` and `reader.optional("X")` —
 * `undefined` when the variable is unset or empty; a value that is set is still checked.
 */
export interface EnvReader<TValue, TPlain = unknown> {
  (variable: string, options?: EnvOptions<TValue>): EnvValue<TValue, TPlain>;
  /** The variable's value, or `undefined` when it is unset or empty. */
  optional(variable: string): EnvValue<TValue | undefined, TPlain>;
}

/** `env.ttl`'s options: `none` is read only when the field allows it (`historyTtl`, `auditLogTtl`). */
export interface EnvTtlOptions {
  readonly default?: Milliseconds | Ttl;
  readonly allowNone?: boolean;
}

/** The readers of `defineEnv`: `env` is `env.text`. */
export interface EnvReaders extends EnvReader<string, string> {
  readonly text: EnvReader<string, string>;
  readonly integer: EnvReader<number, number>;
  readonly number: EnvReader<number>;
  readonly boolean: EnvReader<boolean, boolean>;
  /** The old name of `env.boolean`; removed with the old environment files. */
  readonly flag: EnvReader<boolean, boolean>;
  /** `30d`, `24h`, `15m`, `10s`: a finite duration. */
  readonly duration: EnvReader<Milliseconds>;
  /** A duration or `forever`; `{ allowNone: true }` adds `none`. */
  readonly ttl: {
    (
      variable: string,
      options?: EnvTtlOptions & { readonly allowNone?: false },
    ): EnvRef<Milliseconds | Ttl.Forever>;
    (
      variable: string,
      options: EnvTtlOptions & { readonly allowNone: true },
    ): EnvRef<Milliseconds | Ttl>;
    optional(
      variable: string,
      options?: EnvTtlOptions & { readonly allowNone?: false },
    ): EnvRef<Milliseconds | Ttl.Forever | undefined>;
    optional(
      variable: string,
      options: EnvTtlOptions & { readonly allowNone: true },
    ): EnvRef<Milliseconds | Ttl | undefined>;
  };
  /** `64kb`, `10mb`, `512b`, `1gb`. */
  readonly bytes: EnvReader<Bytes>;
  /** Dollars: `40`, `0.5`. */
  readonly usd: EnvReader<Usd>;
}

const FLAGS: Readonly<Record<string, boolean>> = {
  true: true,
  "1": true,
  false: false,
  "0": false,
};
const flagOf: ValueParser = (raw) => FLAGS[raw.toLowerCase()];
const integerOf: ValueParser = (raw) => (/^-?\d+$/.test(raw) ? Number(raw) : undefined);
const textOf: ValueParser = (raw) => raw;

/** A reader of one kind: its parser and what an unparsable value is called. */
function readerOf(kind: VariableKind, parser: ValueParser, expected: string) {
  const read = (variable: string, options: EnvOptions<unknown> = {}): VariableReference =>
    new VariableReference(
      variable,
      kind,
      options.default,
      VariablePresence.Required,
      parser,
      expected,
    );
  const optional = (variable: string): VariableReference =>
    new VariableReference(variable, kind, undefined, VariablePresence.Optional, parser, expected);
  return Object.assign(read, { optional });
}

function ttlReader() {
  const make = (variable: string, options: EnvTtlOptions, presence: VariablePresence) =>
    new VariableReference(
      variable,
      VariableKind.Text,
      options.default,
      presence,
      ttlOf(options.allowNone === true),
      `a duration (30d, 24h), forever${options.allowNone === true ? " or none" : ""}`,
    );
  return Object.assign(
    (variable: string, options: EnvTtlOptions = {}) =>
      make(variable, options, VariablePresence.Required),
    {
      optional: (variable: string, options: EnvTtlOptions = {}) =>
        make(variable, options, VariablePresence.Optional),
    },
  );
}

const text = readerOf(VariableKind.Text, textOf, "text");

const readers = Object.assign(text, {
  text,
  integer: readerOf(VariableKind.Integer, integerOf, "an integer"),
  number: readerOf(VariableKind.Text, numberOf, "a number"),
  boolean: readerOf(VariableKind.Flag, flagOf, "a flag (true, false, 1, 0)"),
  flag: readerOf(VariableKind.Flag, flagOf, "a flag (true, false, 1, 0)"),
  duration: readerOf(VariableKind.Text, durationOf, "a duration (30d, 24h, 15m, 10s)"),
  ttl: ttlReader(),
  bytes: readerOf(VariableKind.Text, bytesOf, "a size (64kb, 10mb)"),
  usd: readerOf(VariableKind.Text, usdOf, "an amount of dollars (40, 0.5)"),
});

/** The readers return a `VariableReference` that stands for the typed value: the one place they are typed so. */
const isReaders = (value: object): value is EnvReaders => "ttl" in value;

/**
 * `env("REGION")`, `env.integer("PORT")`, `env.boolean("DEBUG")`, `env.duration("DEADLINE")`,
 * `env.ttl("HISTORY_TTL")`, `env.bytes("MAX_FILE")`, `env.usd("DAILY_BUDGET")` — each with `{ default }` and
 * `.optional("VAR")` (#1324). `defineEnv` reads them from the process when the application starts.
 */
export const env: EnvReaders = (() => {
  if (!isReaders(readers)) throw new TypeError("unreachable: env has its readers");
  return readers;
})();
