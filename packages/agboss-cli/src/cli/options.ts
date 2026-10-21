/** The options commands are built from (#198); `commands.ts` lists the commands. */
export interface OptionSpec {
  /** The long flag without dashes: `start` → `--start`. */
  readonly name: string;
  readonly type: "string" | "boolean";
  /** How the value reads in help: `<path>`, `N`. */
  readonly value?: string;
  readonly short?: string;
  readonly help: string;
  readonly required?: boolean;
  readonly default?: string;
}

export interface CommandSpec {
  readonly summary: string;
  readonly usage: string;
  /** What the positional arguments are, for help; none = the command takes none. */
  readonly positionals?: string;
  readonly options: readonly OptionSpec[];
}

export const APPLICATION: OptionSpec = {
  name: "application",
  type: "string",
  value: "<path>",
  help: 'the module exporting the @Application (default: "agboss": { "application" } in package.json)',
};
export const START: OptionSpec = {
  name: "start",
  type: "string",
  value: "<name>",
  help: "the workflow start, by its full name (screening-workflow-start); optional with one start",
};
export const PROFILE: OptionSpec = {
  name: "profile",
  type: "string",
  value: "<name>",
  help: "apply profiles/<workflow>/<name>.yaml",
};
export const THREAD: OptionSpec = {
  name: "thread",
  type: "string",
  value: "<id>",
  help: "continue a conversation",
};
export const ENV: OptionSpec = {
  name: "env",
  type: "string",
  value: "<name>",
  help: "the environment: environments/<name>.environment.ts next to the application (default dev)",
};
export const DRY_RUN: OptionSpec = {
  name: "dry-run",
  type: "boolean",
  help: "show what would be written, write nothing",
};

/** A string option: `--<name> <value>`. */
export const text = (
  name: string,
  value: string,
  help: string,
  extra: Partial<OptionSpec> = {},
): OptionSpec => ({ name, type: "string", value, help, ...extra });

/** A boolean option: `--<name>`. */
export const flag = (name: string, help: string, extra: Partial<OptionSpec> = {}): OptionSpec => ({
  name,
  type: "boolean",
  help,
  ...extra,
});

/** Options every command takes. */
export const COMMON_OPTIONS: readonly OptionSpec[] = [
  flag("json", "machine output: one JSON envelope on stdout, nothing else"),
  flag("debug", "print stack traces of errors"),
  flag("help", "this help (with --json: a machine description)", { short: "h" }),
];

/** The command's own options and the common ones, as the parser and help see them. */
export const optionsOf = (spec: CommandSpec): readonly OptionSpec[] => [
  ...spec.options,
  ...COMMON_OPTIONS,
];
