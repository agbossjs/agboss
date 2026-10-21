import type { CliError } from "./errors.js";

/** Where a CLI call reads and writes: the process in `agboss`, buffers in tests. */
export interface CliIo {
  readonly stdout: { readonly write: (text: string) => unknown };
  readonly stderr: { readonly write: (text: string) => unknown };
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdinIsTTY?: boolean;
  /** false where TypeScript is already compiled (tests); the CLI registers tsx itself by default. */
  readonly registerTypeScript?: boolean;
}

/** Parsed option values: strings and booleans, by long name. */
export type OptionValues = Readonly<Record<string, string | boolean | undefined>>;

/** What a command handler gets. */
export interface CommandContext {
  readonly command: string;
  readonly values: OptionValues;
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly io: CliIo;
  /** Human output: stdout, or stderr under `--json` (stdout then carries only the envelope). */
  readonly say: (line: string) => void;
  /** Diagnostics: always stderr. */
  readonly warn: (line: string) => void;
}

/** What a command reports; the CLI wraps it into the JSON envelope. */
export interface CommandOutcome {
  readonly result?: unknown;
  readonly created?: readonly string[];
  readonly modified?: readonly string[];
  readonly warnings?: readonly string[];
  /** A failure the command already reported in its output (`agboss check` found problems). */
  readonly failure?: CliError;
}

export type CommandHandler = (context: CommandContext) => Promise<CommandOutcome>;

/** A string option's value; undefined when absent. */
export const textOption = (values: OptionValues, name: string): string | undefined => {
  const value = values[name];
  return typeof value === "string" ? value : undefined;
};

/** A string option with a default in its schema (always set after parsing). */
export const requiredText = (values: OptionValues, name: string): string =>
  textOption(values, name) ?? "";

export const flagOption = (values: OptionValues, name: string): boolean => values[name] === true;

/** Load options for `loadApplicationClass`. */
export const loadOptions = (context: CommandContext): { readonly typescript?: boolean } =>
  context.io.registerTypeScript === false ? { typescript: false } : {};
