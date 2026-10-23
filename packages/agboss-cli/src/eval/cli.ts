import { evaluate, goldenFile, goldenFromRecent, replay, saveGolden } from "agboss/internal";
import "dotenv/config";
import {
  requiredText,
  textOption,
  type CommandContext,
  type CommandHandler,
  type CommandOutcome,
} from "../cli/context.js";
import { usageError } from "../cli/errors.js";
import { depsFor } from "./cli-deps.js";
import { compareProfiles } from "./compare-cli.js";

async function replayCommand(context: CommandContext): Promise<CommandOutcome> {
  const deps = await depsFor(context, textOption(context.values, "profile"));
  try {
    const promptVersion = requiredText(context.values, "version");
    const limit = Number(requiredText(context.values, "limit"));
    const report = await replay(deps, deps.evaluation, { promptVersion, limit });
    context.say(JSON.stringify(report, null, 2));
    return { result: report, warnings: deps.warnings };
  } finally {
    await deps.close();
  }
}

/** `agboss eval score` (#396: the bare `agboss eval` before): scores recent runs with Jev. */
async function scoreCommand(context: CommandContext): Promise<CommandOutcome> {
  const deps = await depsFor(context, textOption(context.values, "profile"));
  try {
    const version = textOption(context.values, "version");
    const report = await evaluate(deps.evaluation, deps.config.name, {
      ...(version === undefined ? {} : { promptVersion: version }),
      limit: Number(requiredText(context.values, "limit")),
    });
    const summary = await deps.terns.summary(deps.config.name);
    context.say(JSON.stringify(report));
    summary.forEach((row) => {
      context.say(JSON.stringify(row));
    });
    return { result: { report, summary }, warnings: deps.warnings };
  } finally {
    await deps.close();
  }
}

/** `agboss eval run | score | show` (#396 S4, #397): the subcommand the CLI parsed, first of the positionals. */
async function evalCommand(context: CommandContext): Promise<CommandOutcome> {
  const [subcommand] = context.positionals;
  if (subcommand === "run") return (await import("./run-cli.js")).evalRunCommand(context);
  if (subcommand === "show") return (await import("./show-cli.js")).evalShowCommand(context);
  return scoreCommand(context);
}

async function goldenCommand(context: CommandContext): Promise<CommandOutcome> {
  if (context.positionals[0] !== "add")
    throw usageError("golden", "usage.missing-argument", 'expected "agboss golden add …"');
  const name = requiredText(context.values, "name");
  const deps = await depsFor(context, undefined);
  try {
    const fromLast = Number(requiredText(context.values, "from-last"));
    const set = await goldenFromRecent(deps.terns, deps.config.name, name, fromLast);
    const file = goldenFile(context.io.cwd, deps.config.name, name);
    await saveGolden(file, set);
    context.say(`${String(set.tasks.length)} tasks → ${file}`);
    return { result: { tasks: set.tasks.length, file }, created: [file], warnings: deps.warnings };
  } finally {
    await deps.close();
  }
}

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  eval: evalCommand,
  replay: replayCommand,
  golden: goldenCommand,
  compare: compareProfiles,
};

/** `agboss eval run | score | show`, `replay`, `golden add`, `compare` — see `agboss help <command>`. */
export const handle: CommandHandler = async (context) => {
  const command = COMMANDS[context.command];
  if (command === undefined) throw new Error(`not an eval command: ${context.command}`);
  return command(context);
};
