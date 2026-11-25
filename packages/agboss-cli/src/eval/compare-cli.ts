import type { AppDeps } from "@agboss/core/internal";
import {
  compareBundleProfiles,
  formatComparison,
  goldenFile,
  loadGolden,
} from "@agboss/core/internal";
import {
  requiredText,
  textOption,
  type CommandContext,
  type CommandHandler,
} from "../cli/context.js";
import { usageError } from "../cli/errors.js";
import { startWorkflowOf } from "./cli-deps.js";

async function tasksOf(context: CommandContext, base: AppDeps): Promise<string[]> {
  const golden = textOption(context.values, "golden");
  if (golden === undefined) {
    const last = Number(requiredText(context.values, "last"));
    return (await base.turns.recentOriginals(base.config.name, last)).map((t) => t.task);
  }
  const set = await loadGolden(goldenFile(context.io.cwd, base.config.name, golden));
  return set.tasks.map((t) => t.task);
}

/** `agboss compare [--start <name>] --profiles base,<p>… [--golden <name> | --last N]` (`compareProfiles`). */
export const compareProfiles: CommandHandler = async (context) => {
  const names = requiredText(context.values, "profiles")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length < 2)
    throw usageError(
      "compare",
      "usage.option-value",
      "--profiles needs at least two, e.g. base,<profile>",
    );
  // each profile is its own assembly of the application; layers of one are joined with +
  const { environment } = await startWorkflowOf(context, "base");
  const comparison = await compareBundleProfiles(
    async (name) => (await startWorkflowOf(context, name.split("+"))).bundle,
    names,
    {
      processEnv: context.io.env,
      ...(environment === undefined ? {} : { environment }),
    },
    (base) => tasksOf(context, base),
  );
  comparison.warnings.forEach((warning) => {
    context.warn(`warning: ${warning}`);
  });
  formatComparison(comparison.tasks, comparison.profiles).forEach(context.say);
  return { result: { tasks: comparison.tasks, profiles: comparison.profiles } };
};
