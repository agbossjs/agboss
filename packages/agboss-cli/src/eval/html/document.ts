import { element, renderHtml } from "./html.js";
import { cspHashOf, REPORT_PAGE_SCRIPT } from "./page-script.js";
import { REPORT_PAGE_STYLE } from "./page-style.js";

/**
 * The document every page of the eval report is (#397): its style and its one script inline, no
 * request of any kind — its Content-Security-Policy allows only those two, by hash — around a body
 * already rendered (and escaped) by the sections.
 */

/** Nothing but the page's own style and script; no network, no frames, no forms. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  `style-src ${cspHashOf(REPORT_PAGE_STYLE)}`,
  `script-src ${cspHashOf(REPORT_PAGE_SCRIPT)}`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

/** A whole page: its head (title, CSP, viewport, style), the body, the script. */
export function htmlDocumentOf(title: string, body: string): string {
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
    renderHtml(element("title", {}, [title])),
    `<style>${REPORT_PAGE_STYLE}</style>`,
    "</head><body>",
    body,
    `<script>${REPORT_PAGE_SCRIPT}</script>`,
    "</body></html>\n",
  ].join("");
}
