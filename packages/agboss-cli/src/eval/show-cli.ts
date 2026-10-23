import { textOption, type CommandContext, type CommandOutcome } from "../cli/context.js";
import { usageError } from "../cli/errors.js";
import { readRunArtifact } from "./run-artifact.js";
import { printRunTable } from "./run-report.js";

/**
 * `agboss eval show <run.json> [--html <file>]` (#397 PR 1, S2 Q2): a saved run artifact read back —
 * its table, as `eval run` printed it, and with `--html` the same self-contained page. It loads no
 * application and runs nothing: CI renders a pull request's report without a second model bill.
 */
export async function evalShowCommand(context: CommandContext): Promise<CommandOutcome> {
  const [, path] = context.positionals;
  if (path === undefined)
    throw usageError("eval show", "usage.missing-argument", "expected agboss eval show <run.json>");
  const report = readRunArtifact(context, path);
  printRunTable(context, report);
  const html = textOption(context.values, "html");
  if (html === undefined) return { result: report };
  await (await import("./html-report.js")).writeHtmlReport(context, html, report);
  return { result: report, created: [html] };
}
