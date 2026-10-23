import { createHash } from "node:crypto";

/**
 * The HTML report's one script (#397 PR 1, S2 Q6: plain TypeScript and the DOM, inline): it shows
 * the case filter (hidden without a script — every case then shows), applies a filter, and opens a
 * run's details from its dot or from the page's `#hash`. The page reads fine without it.
 *
 * It is written here as a function and inlined as its source (`Function#toString`), so it must use
 * nothing outside its body: the filter values are the `data-filter` strings `CaseFilter` renders.
 * It is typed by the few DOM members it touches, so the CLI needs no DOM types and a test can run
 * it on a stand-in document.
 */

/** The part of a DOM element the script uses. */
export interface ReportPageElement {
  hidden: boolean;
  /** A `<details>` element's. */
  open?: boolean;
  readonly dataset: Readonly<Record<string, string | undefined>>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: "click", listener: () => void): void;
}

/** The part of the DOM document the script uses. */
export interface ReportPageDocument {
  querySelectorAll(selectors: string): ArrayLike<ReportPageElement>;
  getElementById(id: string): ReportPageElement | null;
}

/** The script itself: called on the page's `document` and `location.hash`. */
export function reportPageScript(page: ReportPageDocument, hash: string): void {
  const all = (selectors: string): ReportPageElement[] =>
    Array.from(page.querySelectorAll(selectors));
  const openRun = (id: string): void => {
    const details = id === "" ? null : page.getElementById(id);
    if (details !== null) details.open = true;
  };
  const isShown = (filter: string, item: ReportPageElement): boolean => {
    if (filter === "failing") return item.dataset.passesAll !== "true";
    if (filter === "unstable") return item.dataset.unstable === "true";
    return true;
  };
  const buttons = all("[data-filter]");
  for (const button of buttons)
    button.addEventListener("click", () => {
      const filter = button.dataset.filter ?? "all";
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
      for (const item of all("[data-passes-all]")) item.hidden = !isShown(filter, item);
    });
  for (const filters of all("[data-filters]")) filters.hidden = false;
  for (const dot of all("a.dot"))
    dot.addEventListener("click", () => {
      openRun((dot.getAttribute("href") ?? "").slice(1));
    });
  openRun(hash.slice(1));
}

/** The script as the page inlines it: the function called on the page. */
export const REPORT_PAGE_SCRIPT = `(${reportPageScript.toString()})(document, location.hash);`;

/** A Content-Security-Policy source for an inline text: its SHA-256. */
export const cspHashOf = (text: string): string =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
