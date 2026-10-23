import { element, renderHtml } from "./html.js";
import { cspHashOf, REPORT_PAGE_SCRIPT } from "./page-script.js";
import { REPORT_PAGE_STYLE } from "./page-style.js";

/**
 * The document every page of the eval report is (#397): its style and its one script inline, no
 * request of any kind — its Content-Security-Policy allows only those two, by hash — around a body
 * already rendered (and escaped) by the sections.
 */

/**
 * Nothing but the page's own style and script; no network, no frames — and no form, unless the page
 * posts to the server that served it (`agboss eval ui`'s labels, #397 PR 4). `style` is the page's
 * stylesheet (the report's; `agboss hub` adds its own rules, #401).
 */
export const contentSecurityPolicyOf = (
  isPostingForms: boolean,
  style: string = REPORT_PAGE_STYLE,
): string =>
  [
    "default-src 'none'",
    `style-src ${cspHashOf(style)}`,
    `script-src ${cspHashOf(REPORT_PAGE_SCRIPT)}`,
    "base-uri 'none'",
    `form-action ${isPostingForms ? "'self'" : "'none'"}`,
  ].join("; ");

/** How a document is made. */
export interface HtmlDocumentOptions {
  readonly isPostingForms?: boolean;
  /** The page's stylesheet; the report's by default. */
  readonly style?: string;
  /** The command that made it, for `<meta name="generator">`; `agboss eval` by default. */
  readonly generator?: string;
}

/** A whole page: its head (title, CSP, viewport, style), the body, the script. */
export function htmlDocumentOf(
  title: string,
  body: string,
  options: HtmlDocumentOptions = {},
): string {
  const style = options.style ?? REPORT_PAGE_STYLE;
  const policy = contentSecurityPolicyOf(options.isPostingForms === true, style);
  const meta = [
    element("meta", { charset: "utf-8" }),
    element("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
    element("meta", { "http-equiv": "Content-Security-Policy", content: policy }),
    element("meta", { name: "color-scheme", content: "light dark" }),
    element("meta", { name: "generator", content: options.generator ?? "agboss eval" }),
  ];
  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    ...meta.map(renderHtml),
    renderHtml(element("title", {}, [title])),
    `<style>${style}</style>`,
    "</head><body>",
    body,
    `<script>${REPORT_PAGE_SCRIPT}</script>`,
    "</body></html>\n",
  ].join("");
}
