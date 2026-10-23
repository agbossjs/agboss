import { inspect } from "node:util";
import { COMMANDS, commandName, type CommandSpec } from "./commands.js";
import type { CliIo, CommandContext, CommandHandler, CommandOutcome } from "./context.js";
import { envelopeOf, envelopeText, failedEnvelope, oneLine } from "./envelope.js";
import { CliError, cliErrorOf, EXIT_CODES, usageError } from "./errors.js";
import { asksForHelp, parseCommand } from "./parse.js";
import { describeCommand, describeCommands, helpFor, usage } from "./usage.js";

/** Commands → their handlers, loaded only when called (help stays fast). */
const HANDLERS: Readonly<Record<string, () => Promise<CommandHandler>>> = {
  chat: async () => (await import("../chat.js")).handle,
  run: async () => (await import("../cli.js")).handle,
  describe: async () => (await import("../describe.js")).handle,
  check: async () => (await import("../check.js")).handle,
  rag: async () => (await import("../rag-index.js")).handle,
  dev: async () => (await import("../dev.js")).handle,
  studio: async () => (await import("../studio.js")).handle,
  eval: async () => (await import("../eval/cli.js")).handle,
  replay: async () => (await import("../eval/cli.js")).handle,
  golden: async () => (await import("../eval/cli.js")).handle,
  compare: async () => (await import("../eval/cli.js")).handle,
  create: async () => (await import("./create.js")).handle,
  generate: async () => (await import("./generate.js")).handle,
  migrate: async () => (await import("./migrate.js")).handle,
};

interface Call {
  readonly command: string;
  readonly json: boolean;
  readonly debug: boolean;
  readonly io: CliIo;
}

const unknownCommand = (given: string): CliError =>
  new CliError("usage", "usage.unknown-command", `unknown command "${given}" — see agboss help`);

/** `agboss help [<command> [<subcommand>]] [--json]`, `agboss <command> [<subcommand>] --help`. */
function help(call: Call, topic: string | undefined, subtopic?: string): number {
  if (topic === undefined) {
    call.io.stdout.write(
      call.json ? envelopeText(envelopeOf("help", { result: describeCommands() })) : usage(),
    );
    return 0;
  }
  const spec = COMMANDS[topic];
  if (spec === undefined) throw unknownCommand(topic);
  const sub = subtopic === undefined ? undefined : subcommandOf(topic, spec, subtopic);
  const [name, shown] = sub === undefined ? [topic, spec] : [`${topic} ${subtopic ?? ""}`, sub];
  const result = describeCommand(name, shown);
  call.io.stdout.write(
    call.json ? envelopeText(envelopeOf("help", { result })) : (helpFor(name) ?? usage()),
  );
  return 0;
}

/** A subcommand of a command made of them; unknown → a usage error naming the known ones. */
function subcommandOf(
  command: string,
  spec: CommandSpec | undefined,
  given: string,
): CommandSpec | undefined {
  if (spec?.subcommands === undefined) return undefined;
  const found = spec.subcommands[given];
  if (found !== undefined) return found;
  const known = Object.keys(spec.subcommands).join(" | ");
  throw new CliError(
    "usage",
    "usage.unknown-command",
    `unknown subcommand "${command} ${given}" — expected ${command} ${known}; see agboss help ${command}`,
  );
}

/**
 * A command made of subcommands (#396: `agboss eval run | score`): the first argument chooses one;
 * none → the command's help (its subcommands listed) and a usage error, exit 2.
 */
async function dispatchSubcommand(
  call: Call,
  spec: CommandSpec,
  rest: readonly string[],
): Promise<number> {
  const [given, ...after] = rest;
  if (given === undefined || given.startsWith("-")) {
    if (asksForHelp(rest)) return help(call, call.command);
    if (!call.json) call.io.stdout.write(helpFor(call.command) ?? usage());
    const known = Object.keys(spec.subcommands ?? {}).join(" | ");
    throw usageError(
      call.command,
      "usage.missing-argument",
      `expected agboss ${call.command} ${known}`,
    );
  }
  const sub = subcommandOf(call.command, spec, given);
  if (sub === undefined) throw unknownCommand(call.command);
  if (asksForHelp(after)) return help(call, call.command, given);
  const { values, positionals } = parseCommand(`${call.command} ${given}`, sub, after);
  return run(call, values, [given, ...positionals]);
}

/** Loads the command's handler and runs it. */
async function run(
  call: Call,
  values: CommandContext["values"],
  positionals: readonly string[],
): Promise<number> {
  const load = HANDLERS[call.command];
  if (load === undefined) throw unknownCommand(call.command);
  const handler = await load();
  return finish(call, await handler(contextOf(call, values, positionals)));
}

function contextOf(
  call: Call,
  values: CommandContext["values"],
  positionals: readonly string[],
): CommandContext {
  const human = call.json ? call.io.stderr : call.io.stdout;
  return {
    command: call.command,
    values,
    positionals,
    json: call.json,
    io: call.io,
    say: (line: string) => human.write(`${line}\n`),
    warn: (line: string) => call.io.stderr.write(`${line}\n`),
  };
}

function finish(call: Call, outcome: CommandOutcome): number {
  if (call.json) call.io.stdout.write(envelopeText(envelopeOf(call.command, outcome)));
  if (outcome.failure === undefined) return 0;
  call.io.stderr.write(`agboss ${call.command}: ${oneLine(outcome.failure.message)}\n`);
  return EXIT_CODES[outcome.failure.kind];
}

function fail(call: Call, thrown: unknown): number {
  const error = cliErrorOf(thrown);
  if (call.json) call.io.stdout.write(envelopeText(failedEnvelope(call.command, error)));
  call.io.stderr.write(`agboss ${call.command}: ${oneLine(error.message)}\n`);
  if (call.debug) call.io.stderr.write(`${inspect(thrown)}\n`);
  return EXIT_CODES[error.kind];
}

async function dispatch(call: Call, rest: readonly string[]): Promise<number> {
  const spec = COMMANDS[call.command];
  if (spec === undefined) throw unknownCommand(call.command);
  if (call.command === "help") {
    const { positionals } = parseCommand("help", spec, rest);
    const [topic, subtopic] = positionals;
    return help(call, topic === undefined ? undefined : commandName(topic), subtopic);
  }
  if (spec.subcommands !== undefined) return dispatchSubcommand(call, spec, rest);
  if (asksForHelp(rest)) return help(call, call.command);
  const { values, positionals } = parseCommand(call.command, spec, rest);
  return run(call, values, positionals);
}

/**
 * The `agboss` command line (#198): `argv` after `agboss` → an exit code. 0 ok · 1 internal · 2 usage ·
 * 3 invalid project · 4 conflict. Errors are one line on stderr (a stack only with `--debug`); with
 * `--json`, stdout carries one envelope and nothing else.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [given, ...rest] = argv;
  const isHelp = given === undefined || given === "--help" || given === "-h";
  const call: Call = {
    command: isHelp ? "help" : commandName(given),
    json: argv.includes("--json"),
    debug: argv.includes("--debug"),
    io,
  };
  try {
    return await dispatch(call, isHelp ? argv.slice(1) : rest);
  } catch (error) {
    return fail(call, error);
  }
}
