import { spawnSync } from "node:child_process";
import { join } from "node:path";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { input } from "@inquirer/prompts";
import { isComplete, specFromFlags } from "../scaffold/flags.js";
import { namesOf } from "../scaffold/names.js";
import { planProject } from "../scaffold/project.js";
import { askMissing } from "../scaffold/questions.js";
import { flagOption, textOption, type CommandContext, type CommandHandler } from "./context.js";
import { CliError, usageError } from "./errors.js";
import { graphifyHint } from "./graphify-hint.js";
import { dryRun, write } from "./scaffold-outcome.js";

async function projectName(context: CommandContext): Promise<string> {
  const [given] = context.positionals;
  if (given !== undefined) return given;
  if (context.io.stdinIsTTY !== true || context.json)
    throw usageError(
      "create",
      "usage.missing-argument",
      "expected <name> (cannot ask without a terminal)",
    );
  return input({ message: "Project (and first workflow) name:" });
}

const flagsOf = (context: CommandContext) => ({
  agents: textOption(context.values, "agents"),
  tools: textOption(context.values, "tools"),
  mcp: textOption(context.values, "mcp"),
  rag: textOption(context.values, "rag"),
  yes: flagOption(context.values, "yes"),
});

function install(context: CommandContext, root: string): void {
  if (flagOption(context.values, "skip-install")) return;
  const result = spawnSync("npm", ["install"], {
    cwd: root,
    stdio: ["inherit", context.json ? "pipe" : "inherit", "inherit"],
  });
  if (result.status !== 0)
    throw new CliError(
      "internal",
      "create.npm-install",
      "npm install failed — run it in the project folder",
    );
}

/** `agboss create <name> [options]` — see `agboss help create`. */
export const handle: CommandHandler = async (context) => {
  const name = await projectName(context);
  const flags = flagsOf(context);
  const partial = specFromFlags(name, flags);
  const spec =
    isComplete(partial) && (flags.yes || flags.agents !== undefined)
      ? partial
      : await askMissing(partial);
  const folder = namesOf(name).kebab;
  const plan = { create: planProject(spec), modify: [] };
  if (flagOption(context.values, "dry-run"))
    return dryRun(context, plan, `${folder}/ (${String(plan.create.length)} files)`);
  const root = join(context.io.cwd, folder);
  const outcome = await write(root, plan, { folder });
  context.say(`Created ${folder}/ (${String(plan.create.length)} files)`);
  install(context, root);
  context.say(
    `\nNext:\n  cd ${folder}\n  npm run types    # .agboss/types.d.ts, the flow's types (npm install runs it)\n  cp .env.example .env    # your OPENROUTER_API_KEY\n  npm run chat`,
  );
  // #480: the optional code graph — one line, whether or not graphify is installed
  context.say(graphifyHint(context.io.env));
  return outcome;
};
