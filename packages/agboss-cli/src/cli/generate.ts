import { planGenerate } from "../scaffold/generate.js";
import type { Changes } from "../scaffold/write.js";
import { textOption, flagOption, type CommandContext, type CommandHandler } from "./context.js";
import { usageError } from "./errors.js";
import { regenerateFlowTypes } from "./flow-types.js";
import { dryRun, write } from "./scaffold-outcome.js";
import { skillsField, syncCommandSkills } from "./skills.js";

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

/** The plan of a kind, and what of it was left out: an eval case reads a kept execution first. */
async function planOf(
  context: CommandContext,
  kind: string,
  name: string,
  options: Record<string, string | undefined>,
): Promise<{ readonly plan: Changes; readonly notes: readonly string[] }> {
  if (kind !== "eval-case")
    return { plan: await planGenerate(kind, name, options, context.io.cwd), notes: [] };
  const { evalCasePlanOf } = await import("./generate-eval-case.js");
  const { changes, skipped } = await evalCasePlanOf(context, name);
  return { plan: changes, notes: skipped.map((line) => `left out: ${line}`) };
}

/** `agboss generate <kind> <name> [options]` — see `agboss help generate`. */
export const handle: CommandHandler = async (context) => {
  const [kind, name] = context.positionals;
  if (kind === undefined || name === undefined)
    throw usageError("generate", "usage.missing-argument", "expected <kind> <name>");
  const options = Object.fromEntries(
    GENERATE_OPTIONS.map((option) => [option, textOption(context.values, option)]),
  );
  const { plan, notes } = await planOf(context, kind, name, options);
  notes.forEach((note) => {
    context.say(`  ${note}`);
  });
  const count = plan.create.length + plan.modify.length;
  if (flagOption(context.values, "dry-run")) return dryRun(context, plan, `${String(count)} files`);
  const force = flagOption(context.values, "force");
  const reset = flagOption(context.values, "reset");
  // the project skills (#305) before the files: the agent that asked reads them next
  const skills = syncCommandSkills(context);
  const written = await write(context.io.cwd, plan, skillsField(skills), { force, reset });
  [...(written.created ?? []), ...(written.modified ?? []), ...(written.warnings ?? [])].forEach(
    (line) => {
      context.say(`  ${line}`);
    },
  );
  await regenerateFlowTypes(context, [...(written.created ?? []), ...(written.modified ?? [])]);
  return { ...written, warnings: [...(written.warnings ?? []), ...notes, ...skills.warnings] };
};
