import type { EvalRunReport } from "agboss/eval";
import { kilobytes, type Bytes } from "agboss/units";
import type { CommandContext } from "../cli/context.js";
import { CliError } from "../cli/errors.js";
import { sizeText } from "./html/format.js";
import { writeOutputFile } from "./output-file.js";

/**
 * `--html <file>` of `agboss eval run` and `agboss eval show` (#397 PR 1): the run artifact as one
 * self-contained page. The renderer loads only here, on demand; a page above its bound is not
 * written — a browser chokes long before a run that large is readable.
 */

/** The largest HTML report written. */
export const MAX_HTML_REPORT_SIZE: Bytes = kilobytes(16 * 1024);

/** Renders the page, checks its size, writes it and says where. */
export async function writeHtmlReport(
  context: CommandContext,
  path: string,
  report: EvalRunReport,
): Promise<void> {
  const { renderEvalReportPage } = await import("./html/report-page.js");
  const page = renderEvalReportPage(report);
  const bytes = Buffer.byteLength(page, "utf8");
  if (bytes > MAX_HTML_REPORT_SIZE)
    throw new CliError(
      "usage",
      "eval.report-too-large",
      `the HTML report would be ${sizeText(bytes)}, above its ${sizeText(MAX_HTML_REPORT_SIZE)} limit: show fewer cases or fewer runs (${path} not written)`,
    );
  writeOutputFile(context, path, page);
  context.say(`html → ${path} (${sizeText(bytes)}, self-contained)`);
}
