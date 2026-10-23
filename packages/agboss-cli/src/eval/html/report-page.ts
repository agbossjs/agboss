import type { EvalRunReport } from "agboss/internal";
import { CASES_SECTION } from "./cases-section.js";
import { reportHeaderOf } from "./header-section.js";
import { element, renderHtml } from "./html.js";
import { cspHashOf, REPORT_PAGE_SCRIPT } from "./page-script.js";
import { REPORT_PAGE_STYLE } from "./page-style.js";
import type { ReportSection } from "./sections.js";
import { SUMMARY_SECTION } from "./summary-section.js";
import { UNSTABLE_SECTION } from "./unstable-section.js";

/**
 * The HTML report of a run artifact (#397 PR 1): one self-contained page — its style and its one
 * script inline, no request of any kind (its Content-Security-Policy allows only those two, by
 * hash) — from the artifact alone, so `eval run --html` and `eval show` give the same page.
 */

/** The sections under the header, in page order; each one shown only when the artifact holds its data. */
const SECTIONS: readonly ReportSection[] = [SUMMARY_SECTION, UNSTABLE_SECTION, CASES_SECTION];

/** Nothing but the page's own style and script; no network, no frames, no forms. */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src ${cspHashOf(REPORT_PAGE_STYLE)}`,
  `script-src ${cspHashOf(REPORT_PAGE_SCRIPT)}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function bodyOf(report: EvalRunReport): string {
  const sections = SECTIONS.filter((section) => section.isShownFor(report)).map((section) =>
    section.render(report),
  );
  const footer = element("footer", {}, [
    `${report.kind} · schemaVersion ${String(report.schemaVersion)} · it shows only what the run artifact holds, as the run wrote it (masked by the application's PII policies).`,
  ]);
  return [reportHeaderOf(report), element("main", {}, sections), footer].map(renderHtml).join("");
}

/** The whole page, as one string. */
export function renderEvalReportPage(report: EvalRunReport): string {
  const title = element("title", {}, [`${report.suite} — eval run`]);
  const meta = [
    element("meta", { charset: "utf-8" }),
    element("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
    element("meta", { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY }),
    element("meta", { name: "color-scheme", content: "light dark" }),
    element("meta", { name: "generator", content: "agboss eval" }),
  ];
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    ...meta.map(renderHtml),
    renderHtml(title),
    `<style>${REPORT_PAGE_STYLE}</style>`,
    "</head><body>",
    bodyOf(report),
    `<script>${REPORT_PAGE_SCRIPT}</script>`,
    "</body></html>\n",
  ].join("");
}
