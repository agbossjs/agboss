import type { EvalCalibration, EvalJudgeCalibration, EvalRaterAgreement } from "@agboss/core/eval";
import { element, type HtmlElement } from "../html/html.js";
import { sectionOf } from "../html/sections.js";

/**
 * The calibration on `agboss eval ui`'s run page (#397 PR 4): each judge of the run against the
 * labels people gave it so far — computed by `calibrateJudges` (#396 PR 4) on every load, so a saved
 * label changes κ at once: κ per pair of raters, the confusion per labeler, the disagreements.
 */

const kappaText = (agreement: EvalRaterAgreement): string =>
  agreement.kappa === undefined ? "—" : agreement.kappa.toFixed(2);

function agreementsTable(judge: EvalJudgeCalibration): HtmlElement {
  const rater = (name: string): string => (name === judge.judge ? `${name} (judge)` : name);
  return element("div", { class: "table-scroll" }, [
    element("table", {}, [
      element("caption", {}, [`${judge.judge}: agreement between raters`]),
      element("thead", {}, [
        element(
          "tr",
          {},
          ["Raters", "Runs", "Agreed", "κ"].map((title) =>
            element("th", { scope: "col" }, [title]),
          ),
        ),
      ]),
      element(
        "tbody",
        {},
        judge.agreements.map((agreement) =>
          element("tr", {}, [
            element("th", { scope: "row" }, [agreement.raters.map(rater).join(" · ")]),
            element("td", { class: "number" }, [String(agreement.n)]),
            element("td", { class: "number" }, [
              `${String(Math.round(agreement.observed * 100))}%`,
            ]),
            element("td", { class: "number" }, [kappaText(agreement)]),
          ]),
        ),
      ),
    ]),
  ]);
}

function judgeView(judge: EvalJudgeCalibration): HtmlElement {
  return element("article", { class: "calibration" }, [
    element("h3", {}, [judge.judge]),
    element("p", { class: "muted" }, [
      `${String(judge.n)} labelled run(s) · labelers: ${judge.labelers.join(", ")}`,
    ]),
    agreementsTable(judge),
    element(
      "ul",
      {},
      judge.confusion.map((matrix) =>
        element("li", {}, [
          `${matrix.labeler}: both passed ${String(matrix.judgePassedLabelerPassed)}, judge passed / ${matrix.labeler} failed ${String(matrix.judgePassedLabelerFailed)}, judge failed / ${matrix.labeler} passed ${String(matrix.judgeFailedLabelerPassed)}, both failed ${String(matrix.judgeFailedLabelerFailed)}`,
        ]),
      ),
    ),
    judge.disagreements.length > 0 &&
      element("div", { class: "step-part" }, [
        element("p", { class: "step-part-title" }, ["Disagreements"]),
        element(
          "ul",
          {},
          judge.disagreements.map((found) =>
            element("li", {}, [
              `${found.runId}: the judge ${found.judgePassed ? "passed" : "failed"} it, ${found.labeler} did not`,
              found.failureTags.length === 0 ? "" : ` — ${found.failureTags.join(", ")}`,
              found.note === undefined ? "" : ` — ${found.note}`,
            ]),
          ),
        ),
      ]),
  ]);
}

/** The section: the judges with labels, or how to start. */
export function calibrationSectionOf(
  calibration: EvalCalibration,
  labelsFile: string,
): HtmlElement {
  return sectionOf("calibration", "Calibration against people's labels", [
    element("p", { class: "muted" }, [
      `${String(calibration.matched)} of ${String(calibration.labels)} label(s) in ${labelsFile} match this run's verdicts${calibration.unmatched > 0 ? ` (${String(calibration.unmatched)} are of other runs)` : ""}.`,
    ]),
    calibration.judges.length === 0
      ? element("p", {}, [
          "No label of this run's judges yet: open a run below and label a judge's verdict.",
        ])
      : element("div", {}, calibration.judges.map(judgeView)),
  ]);
}
