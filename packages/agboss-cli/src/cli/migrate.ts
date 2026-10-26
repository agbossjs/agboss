import { planImportMigration } from "../migrate/project.js";
import { flagOption, type CommandHandler } from "./context.js";
import { usageError } from "./errors.js";
import { dryRun, write } from "./scaffold-outcome.js";

/**
 * `agboss migrate imports [<path>…] [--dry-run]` (#195): rewrites the imports of the old entries
 * (`@agboss/core/core`, `/graph`, `/router`, `/tool`, `/channels`, `/concurrency`) and of renamed
 * names to the current public entries. Default: every TypeScript file of the project.
 */
export const handle: CommandHandler = async (context) => {
  const [what, ...paths] = context.positionals;
  if (what !== "imports")
    throw usageError(
      "migrate",
      "usage.unknown-migration",
      what === undefined ? 'expected "imports"' : `unknown migration "${what}", expected "imports"`,
    );
  const migration = planImportMigration(context.io.cwd, paths.length === 0 ? ["."] : paths);
  migration.warnings.forEach((warning) => {
    context.warn(warning);
  });
  const count = `${String(migration.changes.modify.length)} of ${String(migration.scanned)} files`;
  if (flagOption(context.values, "dry-run")) {
    const planned = dryRun(context, migration.changes, count);
    return { ...planned, warnings: [...(planned.warnings ?? []), ...migration.warnings] };
  }
  const outcome = await write(context.io.cwd, migration.changes);
  outcome.modified?.forEach((path) => {
    context.say(`  ${path}`);
  });
  context.say(`Imports migrated: ${count}`);
  return { ...outcome, warnings: [...(outcome.warnings ?? []), ...migration.warnings] };
};
