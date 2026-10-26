import type { EvalRunReport } from "@agboss/core/eval";
import { BASELINE_SECTION } from "./baseline-section.js";
import { CASES_SECTION } from "./cases-section.js";
import { reportHeaderOf } from "./header-section.js";
import { htmlDocumentOf } from "./document.js";
import { element, renderHtml, type HtmlElement } from "./html.js";
import { TimelineDetail, type ReportSection, type ReportView } from "./sections.js";
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
  options: ReportPageOptions,
  nav: HtmlElement | undefined,
): string {
  const timelines = options.timelines ?? TimelineDetail.All;
  const view: ReportView = {
    timelines,
    ...(options.runExtrasOf === undefined ? {} : { runExtrasOf: options.runExtrasOf }),
  };
  const shown = SECTIONS.filter((section) => section.isShownFor(report)).map((section) =>
    section.render(report, view),
  );
  // the server's own sections go right before the cases (the last one)
  const sections = [...shown.slice(0, -1), ...(options.sections ?? []), ...shown.slice(-1)];
  const footer = element("footer", {}, [
    `${report.kind} · schemaVersion ${String(report.schemaVersion)} · it shows only what the run artifact holds, as the run wrote it (masked by the application's PII policies).${LEFT_OUT[timelines]}`,
  ]);
  return [reportHeaderOf(report, nav), element("main", {}, sections), footer]
    .map(renderHtml)
    .join("");
}

export { TimelineDetail } from "./sections.js";

/** How the page is rendered: whose timelines it shows, and a link back when a server serves it. */
export interface ReportPageOptions extends Pick<ReportView, "runExtrasOf"> {
  readonly timelines?: TimelineDetail;
  /** Sections of the server's own, before the cases (#397 PR 4: the calibration). */
  readonly sections?: readonly HtmlElement[];
  /** The page posts forms to its own server (#397 PR 4); a file's page posts nothing. */
  readonly isPostingForms?: boolean;
  /** `agboss eval ui` (#397 PR 3): the list of runs the page was opened from. */
  readonly back?: { readonly href: string; readonly label: string };
  /** A line of what the server just did (#397 PR 5: a case saved), shown under the link back. */
  readonly notice?: string;
}

/** The whole page, as one string. */
export function renderEvalReportPage(
  report: EvalRunReport,
  options: ReportPageOptions = {},
): string {
  const { back, notice } = options;
  const link =
    back === undefined
      ? undefined
      : element("nav", { "aria-label": "Runs" }, [element("a", { href: back.href }, [back.label])]);
  const status =
    notice === undefined ? undefined : element("p", { class: "notice", role: "status" }, [notice]);
  const nav =
    link === undefined && status === undefined ? undefined : element("div", {}, [link, status]);
  return htmlDocumentOf(`${report.suite} — eval run`, bodyOf(report, options, nav), {
    isPostingForms: options.isPostingForms === true,
  });
}
