import type { EvalCaseReport, EvalRunReport, EvalRunResult } from "agboss/internal";
import { firstFailureOfCase } from "../run-report.js";
import { ATTEMPT_SYMBOLS, attemptStatusOf } from "./attempts.js";
import { element, type HtmlElement } from "./html.js";
import { runDetails } from "./run-details.js";
import { caseAnchor, runAnchor, sectionOf, type ReportSection } from "./sections.js";

/**
 * The cases (#397 PR 1): one entry per case — pass@k / pass^k, a dot per attempt 1…k linked to that
 * run's details, its first failure — under a filter (all, not pass^k, unstable) the page's script
 * turns on; without the script every case shows.
 */

/** The filters' values, read by the page's script from `data-filter` / the cases' data. */
export enum CaseFilter {
  All = "all",
  Failing = "failing",
  Unstable = "unstable",
}

function dotOf(caseIndex: number, result: EvalRunResult): HtmlElement {
  const status = attemptStatusOf(result);
  const label = `Run ${String(result.run)}: ${status}`;
  return element("li", {}, [
    element(
      "a",
      {
        class: `dot dot-${status}`,
        href: `#${runAnchor(caseIndex, result.run)}`,
        title: label,
        "aria-label": label,
      },
      [ATTEMPT_SYMBOLS[status]],
    ),
  ]);
}

const badge = (text: string, tone: string): HtmlElement =>
  element("span", { class: `badge badge-${tone}` }, [text]);

function badgesOf(found: EvalCaseReport, k: string): HtmlElement {
  return element("p", { class: "badges" }, [
    badge(`pass@${k} ${found.passAtK ? "yes" : "no"}`, found.passAtK ? "passed" : "failed"),
    badge(`pass^${k} ${found.passHatK ? "yes" : "no"}`, found.passHatK ? "passed" : "failed"),
    found.isUnstable && badge("unstable", "unstable"),
    element("span", { class: "muted" }, [
      `${String(found.passed)} of ${String(found.runs)} runs passed`,
    ]),
  ]);
}

function firstFailure(found: EvalCaseReport): HtmlElement | undefined {
  const why = firstFailureOfCase(found);
  return why === ""
    ? undefined
    : element("p", { class: "first-failure" }, [`First failure — ${why}`]);
}

function caseEntry(report: EvalRunReport, found: EvalCaseReport, index: number): HtmlElement {
  const anchor = caseAnchor(index);
  const k = String(report.runs);
  return element(
    "li",
    {
      class: "case",
      id: anchor,
      "data-passes-all": String(found.passHatK),
      "data-unstable": String(found.isUnstable),
    },
    [
      element("article", { "aria-labelledby": `${anchor}-title` }, [
        element("h3", { id: `${anchor}-title` }, [found.name]),
        badgesOf(found, k),
        element(
          "ol",
          { class: "attempts", "aria-label": `Runs of ${found.name}` },
          found.runResults.map((result) => dotOf(index, result)),
        ),
        firstFailure(found),
        ...found.runResults.map((result) => runDetails(index, result)),
      ]),
    ],
  );
}

function filterButton(filter: CaseFilter, label: string, count: number): HtmlElement {
  const isPressed = filter === CaseFilter.All;
  return element(
    "button",
    { type: "button", "data-filter": filter, "aria-pressed": String(isPressed) },
    [`${label} (${String(count)})`],
  );
}

function filtersOf(report: EvalRunReport): HtmlElement {
  const k = String(report.runs);
  const { cases } = report;
  return element(
    "div",
    {
      class: "filters",
      role: "group",
      "aria-label": "Show cases",
      "data-filters": true,
      hidden: true,
    },
    [
      filterButton(CaseFilter.All, "All", cases.length),
      filterButton(
        CaseFilter.Failing,
        `Not pass^${k}`,
        cases.filter((found) => !found.passHatK).length,
      ),
      filterButton(
        CaseFilter.Unstable,
        "Unstable",
        cases.filter((found) => found.isUnstable).length,
      ),
    ],
  );
}

export const CASES_SECTION: ReportSection = {
  isShownFor: () => true,
  render: (report: EvalRunReport) =>
    sectionOf("cases", "Cases", [
      filtersOf(report),
      report.cases.length === 0
        ? element("p", { class: "muted" }, ["The suite has no cases."])
        : element(
            "ol",
            { class: "cases" },
            report.cases.map((found, index) => caseEntry(report, found, index)),
          ),
    ]),
};
