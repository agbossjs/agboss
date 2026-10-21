import { COMMANDS, COMMON_OPTIONS, type CommandSpec, type OptionSpec } from "./commands.js";

export { COMMANDS } from "./commands.js";

const pad = (text: string, width: number): string => text.padEnd(width);

/** `agboss help`: every operation. */
export function usage(): string {
  const lines = Object.entries(COMMANDS).map(
    ([name, command]) => `  ${pad(name, 11)} ${command.summary}`,
  );
  return `AGBoss — typed agent workflows on LangGraph

Usage: agboss <command> [options]      (short: agb)

${lines.join("\n")}

The application is set once in package.json — "agboss": { "application": "src/<name>.application.ts" } —
or given with --application <path>. chat, run, eval, replay, golden and compare run one workflow,
chosen by its start: --start <full name> (optional when the application has one start).
Every command takes --json (one JSON envelope on stdout), --debug (stack traces) and --help.
agboss help <command> — its options; agboss help <command> --json — the same, for a machine.

Exit codes: 0 ok · 1 internal error · 2 usage · 3 invalid project · 4 conflict (already exists).

Environment:
  AGBOSS_NO_STAR=1   hide the closing "Star us on GitHub" line on stderr; it is also
                           hidden when stderr is not a terminal, CI is set, or with --json / --quiet.
`;
}

/** `--start <name>`, `--yes, -y`. */
const flagLabel = (option: OptionSpec): string =>
  `--${option.name}${option.value === undefined ? "" : ` ${option.value}`}${option.short === undefined ? "" : `, -${option.short}`}`;

const optionText = (option: OptionSpec): string =>
  `${option.help}${option.required === true ? " (required)" : ""}${option.default === undefined ? "" : ` (default ${option.default})`}`;

function optionLines(options: readonly OptionSpec[], width: number): string {
  return options
    .map((option) => `  ${pad(flagLabel(option), width)}  ${optionText(option)}`)
    .join("\n");
}

/** `agboss help <command>`; undefined for an unknown command. */
export function helpFor(name: string): string | undefined {
  const command = COMMANDS[name];
  if (command === undefined) return undefined;
  const width = Math.max(
    0,
    ...[...command.options, ...COMMON_OPTIONS].map((o) => flagLabel(o).length),
  );
  const own = optionLines(command.options, width);
  return `agboss ${name} — ${command.summary}

Usage: ${command.usage}
${own === "" ? "" : `\nOptions:\n${own}\n`}
Common options:
${optionLines(COMMON_OPTIONS, width)}
`;
}

/** One option as a machine reads it. */
const optionDescription = (option: OptionSpec) => ({
  flag: `--${option.name}`,
  type: option.type,
  ...(option.short === undefined ? {} : { short: `-${option.short}` }),
  ...(option.value === undefined ? {} : { value: option.value }),
  required: option.required === true,
  ...(option.default === undefined ? {} : { default: option.default }),
  description: option.help,
});

/** A command as a machine reads it: `agboss help <command> --json`, `agboss <command> --help --json`. */
export function describeCommand(name: string, command: CommandSpec): Record<string, unknown> {
  return {
    name,
    summary: command.summary,
    usage: command.usage,
    positionals: command.positionals ?? null,
    options: command.options.map(optionDescription),
    commonOptions: COMMON_OPTIONS.map(optionDescription),
  };
}

/** Every command, for `agboss help --json`. */
export const describeCommands = (): Record<string, unknown>[] =>
  Object.entries(COMMANDS).map(([name, command]) => describeCommand(name, command));
