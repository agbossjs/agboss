import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { requiredText, type CommandContext, type CommandOutcome } from "../cli/context.js";
import { CliError, usageError } from "../cli/errors.js";
import { stopSignal } from "../cli/stop-signal.js";

/**
 * `agboss eval ui [--dir <folder>] [--port N]` (#397 PR 3, S2 Q1): the run artifacts of a folder
 * served read-only on 127.0.0.1 — the list of runs and each run's report page — behind a token it
 * prints, until Ctrl+C. It loads no application and runs nothing.
 */

const COMMAND = "eval ui";

/** `--port N`: 0 (a free port) to 65535. */
function uiPortOf(context: CommandContext): number {
  const given = requiredText(context.values, "port");
  const port = Number(given);
  if (Number.isInteger(port) && port >= 0 && port <= 65_535) return port;
  throw usageError(COMMAND, "usage.option-value", `--port must be 0–65535, got "${given}"`);
}

/** `--dir <folder>`: a folder that exists. */
function folderOf(context: CommandContext): string {
  const given = requiredText(context.values, "dir");
  const folder = resolve(context.io.cwd, given);
  if (existsSync(folder) && statSync(folder).isDirectory()) return folder;
  throw new CliError(
    "usage",
    "eval.no-runs",
    `no folder ${given}: write run artifacts there with agboss eval run --report ${given}/<name>.json, or name another with --dir`,
  );
}

export async function evalUiCommand(context: CommandContext): Promise<CommandOutcome> {
  const folder = folderOf(context);
  const port = uiPortOf(context);
  const { startEvalUi } = await import("./ui/ui-server.js");
  const ui = await startEvalUi({ folder, port });
  context.say(`eval ui: ${ui.url}   (Ctrl+C to stop)`);
  context.say(`runs: ${relative(context.io.cwd, folder) || "."}`);
  const { signal, release } = stopSignal();
  try {
    await new Promise<void>((done) => {
      signal.addEventListener("abort", () => {
        done();
      });
    });
  } finally {
    release();
    await ui.close();
  }
  return { result: { folder, port: ui.port } };
}
