import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse } from "dotenv";

/**
 * The project's `.env` (#1318): the one local file of model keys and `defineEnv` values, read from the
 * folder of the `package.json` that holds the application — never from the working directory, which
 * in a monorepo is not the project. A variable the process already has wins (dotenv's rule); there is
 * no `.env.<name>` sprawl: the profile (`--profile`) picks settings, `defineEnv` names the variables.
 */

/** The folder of the nearest `package.json` from `from` up; undefined when there is none. */
export function packageDirOf(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Adds the variables of `<package dir>/.env` that `env` lacks; returns the file read, if any. */
export function loadProjectEnv(
  env: NodeJS.ProcessEnv,
  applicationFile: string,
): string | undefined {
  const dir = packageDirOf(dirname(applicationFile));
  if (dir === undefined) return undefined;
  const file = join(dir, ".env");
  if (!existsSync(file)) return undefined;
  for (const [key, value] of Object.entries(parse(readFileSync(file)))) env[key] ??= value;
  return file;
}
