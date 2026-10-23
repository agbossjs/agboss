import type { EvalRunReport } from "agboss/eval";
import { BASELINE_SECTION } from "./baseline-section.js";
import { CASES_SECTION } from "./cases-section.js";
import { reportHeaderOf } from "./header-section.js";
import { htmlDocumentOf } from "./document.js";
import { element, renderHtml, type HtmlElement } from "./html.js";
import { TimelineDetail, type ReportSection } from "./sections.js";
import { SUMMARY_SECTION } from "./summary-section.js";
import { UNSTABLE_SECTION } from "./unstable-section.js";

/**
 * The HTML report of a run artifact (#397 PR 1): one self-contained page — its style and its one
 * script inline, no request of any kind (its Content-Security-Policy allows only those two, by
 * hash) — from the artifact alone, so `eval run --html` and `eval show` give the same page.
 */

/** The sections under the header, in page order; each one shown only when the artifact holds its data. */
const SECTIONS: readonly ReportSection[] = [
  SUMMARY_SECTION,
  BASELINE_SECTION,
  UNSTABLE_SECTION,
  CASES_SECTION,
];

/** What the footer says of left-out timelines. */
const LEFT_OUT: Readonly<Record<TimelineDetail, string>> = {
  [TimelineDetail.All]: "",
  [TimelineDetail.Failing]:
    " Timelines of cases with pass^k are left out to keep the page under its size bound.",
  [TimelineDetail.None]: " Every timeline is left out to keep the page under its size bound.",
};

function bodyOf(
  report: EvalRunReport,
  timelines: TimelineDetail,
  nav: HtmlElement | undefined,
): string {
  const sections = SECTIONS.filter((section) => section.isShownFor(report)).map((section) =>
    section.render(report, timelines),
  );
  const footer = element("footer", {}, [
    `${report.kind} · schemaVersion ${String(report.schemaVersion)} · it shows only what the run artifact holds, as the run wrote it (masked by the application's PII policies).${LEFT_OUT[timelines]}`,
  ]);
  return [reportHeaderOf(report, nav), element("main", {}, sections), footer]
    .map(renderHtml)
    .join("");
}

export { TimelineDetail } from "./sections.js";

/** How the page is rendered: whose timelines it shows, and a link back when a server serves it. */
export interface ReportPageOptions {
  readonly timelines?: TimelineDetail;
  /** `agboss eval ui` (#397 PR 3): the list of runs the page was opened from. */
  readonly back?: { readonly href: string; readonly label: string };
}

/** The whole page, as one string. */
export function renderEvalReportPage(
  report: EvalRunReport,
  options: ReportPageOptions = {},
): string {
  const timelines = options.timelines ?? TimelineDetail.All;
  const { back } = options;
  const nav =
    back === undefined
      ? undefined
      : element("nav", { "aria-label": "Runs" }, [element("a", { href: back.href }, [back.label])]);
  return htmlDocumentOf(`${report.suite} — eval run`, bodyOf(report, timelines, nav));
}
