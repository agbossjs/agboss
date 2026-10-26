import {
  CaseComparison,
  type EvalCaseComparison,
  type EvalCasePasses,
  type EvalRunComparison,
  type EvalRunReport,
} from "@agboss/core/eval";
import { element, type HtmlElement } from "./html.js";
import { caseAnchor, factsOf, sectionOf, type ReportSection } from "./sections.js";

/**
 * The run against its baseline (#397 PR 2, #396 PR 3's `baseline`): shown only when the artifact
 * was made with `--baseline` — what it was compared with, the regressions first, then every case
 * with its passes on the baseline and now and its verdict (flaky-on-baseline quarantined, changed
 * not compared).
 */

/** How each verdict reads, and its tone on the page. */
const VERDICTS: Readonly<Record<CaseComparison, { readonly text: string; readonly tone: string }>> =
  {
    [CaseComparison.Regressed]: { text: "regressed", tone: "failed" },
    [CaseComparison.Improved]: { text: "improved", tone: "passed" },
    [CaseComparison.Unchanged]: { text: "unchanged", tone: "neutral" },
    [CaseComparison.FlakyOnBaseline]: {
      text: "flaky on the baseline (quarantined)",
      tone: "unstable",
    },
    [CaseComparison.New]: { text: "new", tone: "neutral" },
    [CaseComparison.Removed]: { text: "removed", tone: "neutral" },
    [CaseComparison.Changed]: { text: "changed (not compared)", tone: "neutral" },
  };

const passesText = (passes: EvalCasePasses | undefined): string =>
  passes === undefined ? "—" : `${String(passes.passed)}/${String(passes.runs)}`;

/** The case's name, linked to its entry when this run has it. */
function caseLink(report: EvalRunReport, name: string): HtmlElement {
  const index = report.cases.findIndex((found) => found.name === name);
  return index < 0
    ? element("span", {}, [name])
    : element("a", { href: `#${caseAnchor(index)}` }, [name]);
}

function row(report: EvalRunReport, compared: EvalCaseComparison): HtmlElement {
  const verdict = VERDICTS[compared.comparison];
  return element("tr", { class: `verdict-${compared.comparison}` }, [
    element("th", { scope: "row" }, [caseLink(report, compared.name)]),
    element("td", { class: "number" }, [passesText(compared.baseline)]),
    element("td", { class: "number" }, [passesText(compared.candidate)]),
    element("td", {}, [element("span", { class: `badge badge-${verdict.tone}` }, [verdict.text])]),
  ]);
}

function countsOf(comparison: EvalRunComparison): HtmlElement {
  const counts = Object.values(CaseComparison).flatMap((verdict) => {
    const count = comparison.cases.filter((found) => found.comparison === verdict).length;
    return count === 0 ? [] : [`${String(count)} ${VERDICTS[verdict].text}`];
  });
  return element("p", { class: "badges" }, [counts.join(" · ")]);
}

function baselineOf(report: EvalRunReport, comparison: EvalRunComparison): HtmlElement {
  const k = String(comparison.runs);
  return sectionOf("baseline", "Against the baseline", [
    factsOf([
      ["Baseline", comparison.file],
      ["Its config", comparison.configHash],
      ["Its start", comparison.startedAt],
      ["Its runs per case", k],
      ["Regressed", comparison.regressed.join(", ") || "none"],
    ]),
    countsOf(comparison),
    element("div", { class: "table-scroll" }, [
      element("table", {}, [
        element("caption", {}, ["Each case, the baseline's passes and this run's"]),
        element("thead", {}, [
          element(
            "tr",
            {},
            ["Case", "Baseline", "Now", "Verdict"].map((title) =>
              element("th", { scope: "col" }, [title]),
            ),
          ),
        ]),
        element(
          "tbody",
          {},
          comparison.cases.map((compared) => row(report, compared)),
        ),
      ]),
    ]),
  ]);
}

export const BASELINE_SECTION: ReportSection = {
  isShownFor: (report) => report.baseline !== undefined,
  render: (report: EvalRunReport) =>
    report.baseline === undefined
      ? element("section", { id: "baseline", hidden: true })
      : baselineOf(report, report.baseline),
};
