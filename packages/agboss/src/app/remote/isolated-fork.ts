import { fork } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ForkHandle, ForkLauncher, ForkSpec } from "./isolated-supervisor.js";

/**
 * The process of an isolated worker (#1286b): the launcher the supervisor uses in production, and
 * the spec the process reads from its environment. The process is `isolated-fork-main.js` (or its
 * source under a TypeScript loader, whatever extension this module has) next to this one, started
 * with Node's `fork` — an IPC channel to its supervisor, which also tells it when the supervisor is
 * gone (the fork closes then, never lingers).
 */

/** The variable carrying the spec of the fork; removed from the fork's environment once read. */
export const FORK_ENV = "AGBOSS_ISOLATED_WORKER";

const Spec = z.object({
  entry: z.string().min(1),
  tenantId: z.string().min(1),
  executionId: z.string().min(1),
  profile: z.union([z.string(), z.array(z.string())]).optional(),
  databasePath: z.string().min(1).optional(),
});

/** The spec of the fork a process was started for; `undefined` when it was started for none. */
export function forkSpecOf(env: NodeJS.ProcessEnv): ForkSpec | undefined {
  const raw = env[FORK_ENV];
  if (raw === undefined) return undefined;
  return Spec.parse(JSON.parse(raw));
}

/** The fork's main module, next to this one. */
export function forkMainPath(): string {
  const here = fileURLToPath(import.meta.url);
  return join(dirname(here), `isolated-fork-main${extname(here)}`);
}

/** Starts the process of an isolated child: a Node child process of the supervisor, with its stdio. */
export const launchFork: ForkLauncher = (spec: ForkSpec): ForkHandle => {
  const child = fork(forkMainPath(), [], {
    env: { ...process.env, [FORK_ENV]: JSON.stringify(spec) },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
    // a process that could not start never exits: it is gone all the same
    child.once("error", () => {
      resolve();
    });
  });
  return {
    exited,
    terminate: () => {
      child.kill("SIGTERM");
    },
    kill: () => {
      child.kill("SIGKILL");
    },
  };
};
