import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The one line `agboss create` says about the optional code graph (#480): graphify
 * (https://github.com/safishamsi/graphify) is looked up on the PATH of the CLI's environment,
 * never run — the project works the same without it.
 */

/** Whether `path` is a file this process may execute. */
function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The names `command` has on `platform`: itself, and on Windows with each `PATHEXT` extension. */
const namesOf = (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] =>
  platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT")
        .split(";")
        .filter((extension) => extension !== "")
        .map((extension) => `${command}${extension.toLowerCase()}`)
    : [command];

/** Whether an executable `command` is in one of the folders of `env.PATH`. */
export function isOnPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const folders = (env.PATH ?? env.Path ?? "").split(delimiter).filter((one) => one !== "");
  const names = namesOf(command, env, platform);
  return folders.some((folder) => names.some((name) => isExecutable(join(folder, name), platform)));
}

const ENABLE = "graphify install --project && graphify update .";

/** What `create` says: how to build the graph, and first how to install graphify when it is missing. */
export const graphifyHint = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string =>
  isOnPath("graphify", env, platform)
    ? `Code graph for agents: ${ENABLE}`
    : `Code graph for agents (optional): install graphify (pipx install graphifyy), then ${ENABLE}`;
