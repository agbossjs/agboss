import { APPLICATION, DRY_RUN, flag, PROFILE, type CommandSpec } from "./options.js";

/** `agboss migrate imports | db`: the import rewrite (#195) and the database migration (#1321f). */
export const MIGRATE_COMMAND: CommandSpec = {
  summary:
    "migrate imports (rewrite deprecated entries to @agboss/core's) or the application's database (db)",
  usage:
    "agboss migrate imports [<path>…] [--dry-run] | agboss migrate db [--application <path>] [--profile <list>] [--allow-live-leases]",
  positionals: "imports [<path>…] | db",
  options: [
    DRY_RUN,
    APPLICATION,
    PROFILE,
    flag(
      "allow-live-leases",
      "db: migrate although execution leases are live (refused with store.live-leases otherwise)",
    ),
  ],
};
