import { planImportMigration } from "../migrate/project.js";
import { flagOption, textOption, type CommandContext, type CommandHandler } from "./context.js";
import { usageError } from "./errors.js";
import { dryRun, write } from "./scaffold-outcome.js";

/**
 * `agboss migrate imports [<path>…] [--dry-run]` (#195): rewrites the imports of the old entries
 * (`@agboss/core/core`, `/graph`, `/router`, `/tool`, `/channels`, `/concurrency`) and of renamed
 * names to the current public entries. Default: every TypeScript file of the project.
 */
export const handle: CommandHandler = async (context) => {
  const [what, ...paths] = context.positionals;
  if (what === "db") return migrateDatabase(context);
  if (what !== "imports")
    throw usageError(
      "migrate",
      "usage.unknown-migration",
      what === undefined
        ? 'expected "imports" or "db"'
        : `unknown migration "${what}", expected "imports" or "db"`,
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

/**
 * `agboss migrate db [--application <path>] [--profile <list>] [--allow-live-leases]` (#1321f): the
 * application's `@DatabaseStorage` driver migrated — one command for every store package, in place
 * of their own `agboss-postgres` / `agboss-mongodb` bins. The profile's config is loaded before the
 * storage is resolved, so a profile-overridden driver is the one migrated. Live leases refuse it
 * (`store.live-leases`) unless `--allow-live-leases`.
 */
async function migrateDatabase(context: CommandContext) {
  // loaded on use: `migrate imports` needs neither the application nor the core's internals
  const { migratedDatabaseOf } = await import("@agboss/core/internal");
  const { assembleApplication, loadCliApplication } = await import("./cli-application.js");
  const loaded = await loadCliApplication(context);
  const assembled = await assembleApplication(
    context,
    loaded,
    textOption(context.values, "profile"),
  );
  const run = await migratedDatabaseOf(assembled.storage, context.io.env, {
    allowLiveLeases: flagOption(context.values, "allow-live-leases"),
  });
  if (run === undefined) {
    context.say("Nothing to migrate: the application's database driver migrates nothing.");
    return { result: { backend: null, applied: [] } };
  }
  run.applied.forEach((step) => {
    context.say(`  ${step}`);
  });
  context.say(`Database migrated (${run.backend}): ${String(run.applied.length)} steps applied`);
  return { result: run };
}
