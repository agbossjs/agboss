import type { EvalRunReport } from "agboss/eval";
import { element, type HtmlChild, type HtmlElement } from "./html.js";

/**
 * A part of the HTML report (#397 PR 1). The page is the list of its sections in order, each shown
 * only when the artifact holds what it needs — so a section for data a later artifact carries (the
 * comparison with a baseline, #396 PR 3) is one more entry, rendered only for artifacts that have it.
 */
export interface ReportSection {
  /** Whether the artifact holds what the section shows. */
  readonly isShownFor: (report: EvalRunReport) => boolean;
  readonly render: (report: EvalRunReport) => HtmlElement;
}

/** `<section>` with its heading, labelled by it. */
export function sectionOf(id: string, title: string, children: readonly HtmlChild[]): HtmlElement {
  const heading = `${id}-title`;
  return element("section", { id, "aria-labelledby": heading }, [
    element("h2", { id: heading }, [title]),
    ...children,
  ]);
}

/** A `<dl>` of label / value rows, each row a `<div>` (a value left out when empty). */
export function factsOf(rows: readonly (readonly [string, string])[]): HtmlElement {
  return element(
    "dl",
    { class: "facts" },
    rows
      .filter(([, value]) => value !== "")
      .map(([label, value]) =>
        element("div", {}, [element("dt", {}, [label]), element("dd", {}, [value])]),
      ),
  );
}

/** The anchor of a case (by its position: a case name is any text). */
export const caseAnchor = (caseIndex: number): string => `case-${String(caseIndex + 1)}`;

/** The anchor of one run of a case. */
export const runAnchor = (caseIndex: number, run: number): string =>
  `${caseAnchor(caseIndex)}-run-${String(run)}`;
