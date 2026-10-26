import type { EvalRunReport } from "@agboss/core/eval";
import { kilobytes, type Bytes } from "@agboss/core/units";
import { renderEvalReportPage, TimelineDetail, type ReportPageOptions } from "./report-page.js";

/**
 * The report page within its size bound (#397 PR 1–3), for a file (`--html`) and for `agboss eval
 * ui` alike: every timeline first; a page above the bound leaves out those of cases with pass^k,
 * then all; one still above it is refused — a browser chokes long before a run that large reads.
 */

/** The largest report page made. */
export const MAX_HTML_REPORT_SIZE: Bytes = kilobytes(16 * 1024);

/** A page within the bound, or the size of the smallest one, which is not. */
export type BoundedPage =
  | {
      readonly kind: "page";
      readonly page: string;
      readonly bytes: number;
      readonly timelines: TimelineDetail;
    }
  | { readonly kind: "too-large"; readonly bytes: number };

/** The richest page of the run within the bound. */
export function boundedPageOf(
  report: EvalRunReport,
  options: Omit<ReportPageOptions, "timelines"> = {},
): BoundedPage {
  let bytes = 0;
  for (const timelines of [TimelineDetail.All, TimelineDetail.Failing, TimelineDetail.None]) {
    const page = renderEvalReportPage(report, { ...options, timelines });
    bytes = Buffer.byteLength(page, "utf8");
    if (bytes <= MAX_HTML_REPORT_SIZE) return { kind: "page", page, bytes, timelines };
  }
  return { kind: "too-large", bytes };
}
