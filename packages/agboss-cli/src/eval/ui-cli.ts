import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { userInfo } from "node:os";
import {
  requiredText,
  textOption,
  type CommandContext,
  type CommandOutcome,
} from "../cli/context.js";
import { CliError, usageError } from "../cli/errors.js";
import { stopSignal } from "../cli/stop-signal.js";
import type { GoldenSource } from "./ui/golden-case.js";
import type { EvalUiOptions } from "./ui/ui-server.js";

/**
 * `agboss eval ui [--dir <folder>] [--port N] [--labels-dir <folder>] [--taxonomy <file>] [--labeler
 * <name>]` (#397 PR 3–4, S2 Q1): the run artifacts of a folder served on 127.0.0.1 — the list of
 * runs, each run's report page with its label forms and calibration — behind a token it prints,
 * until Ctrl+C — and "save as golden case" (PR 5): a run's kept execution written into its suite's
 * file. It builds and runs nothing; it writes only the labels files and the suites' files.
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

/** What "save as golden case" will do, in one line. */
const goldenLine = (golden: GoldenSource): string =>
  golden.kind === "kept"
    ? "golden cases: saved into the suites' files"
    : `golden cases: off — ${golden.reason}`;

/** The server, until Ctrl+C. */
async function served(
  context: CommandContext,
  options: EvalUiOptions,
  files: string,
): Promise<CommandOutcome> {
  const { startEvalUi } = await import("./ui/ui-server.js");
  const ui = await startEvalUi(options);
  context.say(`eval ui: ${ui.url}   (Ctrl+C to stop)`);
  context.say(`runs: ${relative(context.io.cwd, options.folder) || "."} · ${files}`);
  context.say(goldenLine(options.golden));
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
  return { result: { folder: options.folder, port: ui.port } };
}

export async function evalUiCommand(context: CommandContext): Promise<CommandOutcome> {
  const folder = folderOf(context);
  const port = uiPortOf(context);
  const labelsGiven = requiredText(context.values, "labels-dir");
  const taxonomyGiven = requiredText(context.values, "taxonomy");
  const { taxonomyTagsOf } = await import("./ui/taxonomy-file.js");
  const tags = taxonomyTagsOf(resolve(context.io.cwd, taxonomyGiven), taxonomyGiven);
  const labeler = textOption(context.values, "labeler") ?? userInfo().username;
  const { goldenSourceOf } = await import("./ui/golden-source.js");
  const golden = await goldenSourceOf(context);
  try {
    return await served(
      context,
      {
        folder,
        port,
        labelsFolder: resolve(context.io.cwd, labelsGiven),
        tags,
        labeler,
        golden: golden.source,
      },
      `labels: ${labelsGiven} · taxonomy: ${tags === undefined ? `none (${taxonomyGiven} not found)` : `${taxonomyGiven} (${String(tags.length)} tags)`}`,
    );
  } finally {
    await golden.close();
  }
}
