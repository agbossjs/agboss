import { spawn } from "node:child_process";
import { relative } from "node:path";
import { applicationPathOf } from "./cli/application-path.js";
import { flagOption, type CommandContext, type CommandHandler } from "./cli/context.js";
import { checkCommandOf, watchedFolderOf, type PassOptions } from "./cli/dev.js";
import { envOption } from "./cli/environment.js";
import type { CommandLine } from "./cli/studio.js";
import { watchSources } from "./cli/watch.js";

/** Quiet time after the last change before a pass (an editor's save writes several files). */
const DEBOUNCE_MS = 200;

/** One pass in a child process, its output as this command's; resolves when it exits. */
function runChild(context: CommandContext, line: CommandLine): Promise<void> {
  const child = spawn(line.command, line.args, {
    cwd: context.io.cwd,
    env: context.io.env,
    stdio: ["ignore", context.json ? 2 : 1, 2],
  });
  return new Promise<void>((resolve) => {
    child.once("error", (error) => {
      context.warn(`agboss dev: the check did not start: ${error.message}`);
      resolve();
    });
    child.once("exit", () => {
      resolve();
    });
  });
}

/** Aborts on Ctrl+C or SIGTERM; the listeners leave with the loop. */
function stopSignal(): { readonly signal: AbortSignal; readonly release: () => void } {
  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    signal: controller.signal,
    release: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    },
  };
}

/**
 * `agboss dev [--env <name>] [--strict] [--application <path>]` (#268 AC6) — watch mode: the types
 * regenerated and the assembly problems printed on every change of the application's sources,
 * until Ctrl+C.
 */
export const handle: CommandHandler = async (context) => {
  const path = applicationPathOf(context);
  const folder = watchedFolderOf(path.file);
  const pass: PassOptions = {
    file: path.file,
    env: envOption(context),
    strict: flagOption(context.values, "strict"),
  };
  const line = checkCommandOf({ execArgv: process.execArgv, script: process.argv[1] ?? "" }, pass);
  const watched = relative(context.io.cwd, folder) || ".";
  context.say(`dev: watching ${watched} — Ctrl+C to stop`);
  const { signal, release } = stopSignal();
  try {
    await watchSources({
      folder,
      debounce: DEBOUNCE_MS,
      signal,
      pass: async (changed) => {
        if (changed.length > 0) context.say(`dev: changed ${changed.join(", ")}`);
        await runChild(context, line);
      },
    });
  } finally {
    release();
  }
  return { result: { application: path.shown, watched } };
};
