import type { EvalRunReport } from "agboss/eval";
import type { CommandContext } from "../cli/context.js";
import { CliError } from "../cli/errors.js";
import { sizeText } from "./html/format.js";
import { writeOutputFile } from "./output-file.js";

/**
 * `--html <file>` of `agboss eval run` and `agboss eval show` (#397 PR 1): the run artifact as one
 * self-contained page, within its size bound (`boundedPageOf`: timelines left out before a page is
 * refused). The renderer loads only here, on demand.
 */

/** What the CLI line says of the timelines a page left out. */
const LEFT_OUT: Readonly<Record<string, string>> = {
  all: "",
  failing: "; timelines of cases without pass^k only",
  none: "; no timelines",
};

/** Renders the page, checks its size, writes it and says where. */
export async function writeHtmlReport(
  context: CommandContext,
  path: string,
  report: EvalRunReport,
): Promise<void> {
  const { boundedPageOf, MAX_HTML_REPORT_SIZE } = await import("./html/bounded-page.js");
  const bounded = boundedPageOf(report);
  if (bounded.kind === "too-large")
    throw new CliError(
      "usage",
      "eval.report-too-large",
      `the HTML report would be ${sizeText(bounded.bytes)} without any timeline, above its ${sizeText(MAX_HTML_REPORT_SIZE)} limit: show fewer cases or fewer runs (${path} not written)`,
    );
  writeOutputFile(context, path, bounded.page);
  const leftOut = LEFT_OUT[bounded.timelines] ?? "";
  context.say(`html → ${path} (${sizeText(bounded.bytes)}, self-contained${leftOut})`);
}
