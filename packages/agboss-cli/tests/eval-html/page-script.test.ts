/**
 * #397 PR 1 — the report's one script, run as the page inlines it (its source text, in a fresh
 * context) on a stand-in document built from a rendered page: the filter appears and filters, a dot
 * opens its run, the page's `#hash` opens one.
 */
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ReportPageDocument, ReportPageElement } from "../../src/eval/html/page-script.js";
import { REPORT_PAGE_SCRIPT } from "../../src/eval/html/page-script.js";
import { renderEvalReportPage } from "../../src/eval/html/report-page.js";
import { REFUNDS_ARTIFACT } from "./artifacts.js";
import { TRACED_ARTIFACT } from "./traced-artifacts.js";

/** An element of the stand-in document: its tag, attributes and click listeners. */
interface StandInElement extends ReportPageElement {
  readonly tag: string;
  readonly attributes: Map<string, string>;
  click(): void;
}

const camel = (name: string): string =>
  name.replace(/-(\w)/gu, (_, letter: string) => letter.toUpperCase());

function standInOf(
  tag: string,
  attributes: Map<string, string>,
  parentElement: StandInElement | null,
): StandInElement {
  const listeners: (() => void)[] = [];
  const dataset = Object.fromEntries(
    [...attributes]
      .filter(([name]) => name.startsWith("data-"))
      .map(([name, value]) => [camel(name.slice(5)), value]),
  );
  return {
    tag,
    tagName: tag.toUpperCase(),
    parentElement,
    attributes,
    hidden: attributes.has("hidden"),
    open: false,
    dataset,
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    addEventListener: (_type, listener) => listeners.push(listener),
    click: () => {
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}

const VOID_TAGS = new Set(["meta", "br", "hr", "link", "img", "input"]);

const attributesOf = (text: string): Map<string, string> =>
  new Map(
    [...text.matchAll(/\s([\w-]+)(?:="([^"]*)")?/gu)].map(([, name, value]) => [
      name ?? "",
      value ?? "",
    ]),
  );

/** The page's elements as a tree (its style and script left out), found by the selectors the script uses. */
function standInDocument(
  page: string,
): ReportPageDocument & { readonly elements: StandInElement[] } {
  const body = page.replace(/<(style|script)>[\s\S]*?<\/\1>/gu, "");
  const elements: StandInElement[] = [];
  const open: StandInElement[] = [];
  for (const [, closing, tag = "", attributes = ""] of body.matchAll(
    /<(\/?)(\w+)((?:\s[\w-]+(?:="[^"]*")?)*)>/gu,
  )) {
    if (closing === "/") {
      open.pop();
      continue;
    }
    const found = standInOf(tag, attributesOf(attributes), open.at(-1) ?? null);
    elements.push(found);
    if (!VOID_TAGS.has(tag)) open.push(found);
  }
  const matches = (selectors: string, found: StandInElement): boolean =>
    selectors === "a[data-opens]"
      ? found.tag === "a" && found.attributes.has("data-opens")
      : found.attributes.has(selectors.slice(1, -1));
  return {
    elements,
    querySelectorAll: (selectors) => elements.filter((found) => matches(selectors, found)),
    getElementById: (id) => elements.find((found) => found.attributes.get("id") === id) ?? null,
  };
}

const PAGE = renderEvalReportPage(REFUNDS_ARTIFACT);

function runScript(hash = ""): ReturnType<typeof standInDocument> {
  const document = standInDocument(PAGE);
  runInNewContext(REPORT_PAGE_SCRIPT, { document, location: { hash } });
  return document;
}

const byAttribute = (
  document: ReturnType<typeof standInDocument>,
  name: string,
  value: string,
): StandInElement => {
  const found = document.elements.find((each) => each.attributes.get(name) === value);
  if (found === undefined) throw new Error(`no element with ${name}="${value}"`);
  return found;
};

const shownCases = (document: ReturnType<typeof standInDocument>): string[] =>
  document.elements
    .filter((each) => each.attributes.has("data-passes-all") && !each.hidden)
    .map((each) => each.attributes.get("id") ?? "");

describe("#397 PR 1: the report's script", () => {
  it("shows the filter, which is hidden without a script", () => {
    expect(PAGE).toContain("data-filters hidden>");

    const document = runScript();

    expect(byAttribute(document, "aria-label", "Show cases").hidden).toBe(false);
  });

  it("filters the cases: not pass^k, unstable, all — and says which button is pressed", () => {
    const document = runScript();
    const failing = byAttribute(document, "data-filter", "failing");
    const unstable = byAttribute(document, "data-filter", "unstable");

    failing.click();
    expect(shownCases(document)).toEqual(["case-2", "case-3"]);
    expect(failing.getAttribute("aria-pressed")).toBe("true");
    unstable.click();
    expect(shownCases(document)).toEqual(["case-2"]);
    expect(failing.getAttribute("aria-pressed")).toBe("false");
    byAttribute(document, "data-filter", "all").click();
    expect(shownCases(document)).toEqual(["case-1", "case-2", "case-3"]);
  });

  it("a dot opens its run's details", () => {
    const document = runScript();

    byAttribute(document, "href", "#case-2-run-3").click();

    expect(document.getElementById("case-2-run-3")?.open).toBe(true);
    expect(document.getElementById("case-2-run-2")?.open).toBe(false);
  });

  it("a link to a run (#case-3-run-1) opens it on load", () => {
    const document = runScript("#case-3-run-1");

    expect(document.getElementById("case-3-run-1")?.open).toBe(true);
  });

  it("an unstable case's link opens the run around the step it names (#397 PR 2)", () => {
    const document = standInDocument(renderEvalReportPage(TRACED_ARTIFACT));
    runInNewContext(REPORT_PAGE_SCRIPT, { document, location: { hash: "" } });

    byAttribute(document, "href", "#case-2-run-1-step-2").click();

    expect(document.getElementById("case-2-run-1")?.open).toBe(true);
    expect(document.getElementById("case-2-run-2")?.open).toBe(false);
  });
});
