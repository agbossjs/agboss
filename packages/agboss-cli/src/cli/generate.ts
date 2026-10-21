import { planGenerate } from "../scaffold/generate.js";
import { textOption, flagOption, type CommandHandler } from "./context.js";
import { usageError } from "./errors.js";
import { regenerateFlowTypes } from "./flow-types.js";
import { dryRun, write } from "./scaffold-outcome.js";

const GENERATE_OPTIONS = [
  "workflow",
  "application",
  "agent",
  "description",
  "dir",
  "command",
  "tool",
  "folder",
  "url",
  "operations",
] as const;

/** `agboss generate <kind> <name> [options]` — see `agboss help generate`. */
export const handle: CommandHandler = async (context) => {
  const [kind, name] = context.positionals;
  if (kind === undefined || name === undefined)
    throw usageError("generate", "usage.missing-argument", "expected <kind> <name>");
  const options = Object.fromEntries(
    GENERATE_OPTIONS.map((option) => [option, textOption(context.values, option)]),
  );
  const plan = await planGenerate(kind, name, options, context.io.cwd);
  const count = plan.create.length + plan.modify.length;
  if (flagOption(context.values, "dry-run")) return dryRun(context, plan, `${String(count)} files`);
  const force = flagOption(context.values, "force");
  const reset = flagOption(context.values, "reset");
  const outcome = await write(context.io.cwd, plan, {}, { force, reset });
  [...(outcome.created ?? []), ...(outcome.modified ?? []), ...(outcome.warnings ?? [])].forEach(
    (line) => {
      context.say(`  ${line}`);
    },
  );
  await regenerateFlowTypes(context, [...(outcome.created ?? []), ...(outcome.modified ?? [])]);
  return outcome;
};
