import type { EvalRunReport } from "agboss/eval";
import { kilobytes, type Bytes } from "agboss/units";
import type { CommandContext } from "../cli/context.js";
import { CliError } from "../cli/errors.js";
import { sizeText } from "./html/format.js";
import { writeOutputFile } from "./output-file.js";

/**
 * `--html <file>` of `agboss eval run` and `agboss eval show` (#397 PR 1): the run artifact as one
 * self-contained page. The renderer loads only here, on demand. A page above its bound leaves out
 * timelines (#397 PR 2): first those of cases with pass^k, then all; one still above it is not
 * written — a browser chokes long before a run that large is readable.
 */

/** What the CLI line says of the timelines a page left out. */
const LEFT_OUT: Readonly<Record<string, string>> = {
  all: "",
  failing: "; timelines of cases without pass^k only",
  none: "; no timelines",
};

/** The largest HTML report written. */
export const MAX_HTML_REPORT_SIZE: Bytes = kilobytes(16 * 1024);

/** Renders the page, checks its size, writes it and says where. */
export async function writeHtmlReport(
  context: CommandContext,
  path: string,
  report: EvalRunReport,
): Promise<void> {
  const { renderEvalReportPage, TimelineDetail } = await import("./html/report-page.js");
  let bytes = 0;
  for (const timelines of [TimelineDetail.All, TimelineDetail.Failing, TimelineDetail.None]) {
    const page = renderEvalReportPage(report, timelines);
    bytes = Buffer.byteLength(page, "utf8");
    if (bytes > MAX_HTML_REPORT_SIZE) continue;
    writeOutputFile(context, path, page);
    context.say(`html → ${path} (${sizeText(bytes)}, self-contained${LEFT_OUT[timelines] ?? ""})`);
    return;
  }
  throw new CliError(
    "usage",
    "eval.report-too-large",
    `the HTML report would be ${sizeText(bytes)} without any timeline, above its ${sizeText(MAX_HTML_REPORT_SIZE)} limit: show fewer cases or fewer runs (${path} not written)`,
  );
}
