// The arguments of scripts/check-packed.mjs (#497).

export const USAGE = `usage: node scripts/check-packed.mjs [--dir <folder>] [--keep]
       node scripts/check-packed.mjs --verify-install <project>

  Packs @agboss/core and @agboss/cli, creates a project outside the workspace with the packed CLI,
  installs the tarballs there and runs its tests, agboss describe and agboss check (npm run check:packed).

  --dir <folder>              work in this folder (default: a new temporary one)
  --keep                      keep the work folder (default: removed when every check passed)
  --verify-install <project>  only check that <project> has @agboss/core installed, not linked`;

/** A wrong command line: its message and the usage, exit 2. */
export class UsageError extends Error {}

/** The option a flag with a value sets. */
const VALUED = { "--dir": "dir", "--verify-install": "verifyInstall" };
const FLAGS = { "--keep": "keep", "--help": "help", "-h": "help" };

/** The value after `argv[i]`, the flag's. */
function valueAfter(argv, i) {
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--"))
    throw new UsageError(`${argv[i]} needs a value`);
  return value;
}

/** `{ dir?, keep, verifyInstall?, help }` from `process.argv.slice(2)`. */
export function parseArguments(argv) {
  const options = { keep: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(FLAGS, arg)) options[FLAGS[arg]] = true;
    else if (Object.hasOwn(VALUED, arg)) options[VALUED[arg]] = valueAfter(argv, i++);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  if (options.verifyInstall !== undefined && (options.dir !== undefined || options.keep))
    throw new UsageError("--verify-install takes no other option");
  return options;
}
