import type { EvalLabel, EvalRunReport } from "agboss/eval";
import { calibrateJudges, evalLabelOf, type EvalFailureTag } from "agboss/internal";
import { runAnchor } from "../html/sections.js";
import { saveSuiteLabel, suiteLabelsOf } from "./labels-file.js";
import { seeOther, textResponse, type EvalUiResponse } from "./ui-responses.js";

/**
 * `POST /runs/<file>/labels` (#397 PR 4): one person's label of one judge's verdict on one run of
 * the artifact, from its page's form — validated as a line of the labels file, its tags from the
 * taxonomy, matched to a verdict the run has — saved to the suite's labels file, then back to the
 * run on its page.
 */

/** What saving needs besides the form. */
export interface SaveLabelContext {
  readonly file: string;
  readonly report: EvalRunReport;
  readonly labelsFolder: string;
  readonly tags: readonly EvalFailureTag[] | undefined;
  readonly runPage: (fragment: string) => string;
}

/** A form field as given; empty when absent. */
const fieldOf = (form: URLSearchParams, name: string): string => (form.get(name) ?? "").trim();

/** `passed` as the form sends it: "true" or "false"; anything else is no verdict. */
const VERDICTS: Readonly<Record<string, boolean>> = { true: true, false: false };

/** The form's fields as a label (not yet validated). */
function labelValueOf(form: URLSearchParams): unknown {
  const score = fieldOf(form, "score");
  const note = fieldOf(form, "note");
  return {
    runId: fieldOf(form, "runId"),
    executionId: fieldOf(form, "executionId"),
    judge: fieldOf(form, "judge"),
    labeler: fieldOf(form, "labeler"),
    passed: VERDICTS[fieldOf(form, "passed")],
    ...(score === "" ? {} : { score: Number(score) }),
    failureTags: form.getAll("failureTags"),
    ...(note === "" ? {} : { note }),
  };
}

/** Why the label does not fit this run and taxonomy; undefined when it does. */
function misfitOf(context: SaveLabelContext, label: EvalLabel): string | undefined {
  const unknown = label.failureTags.filter(
    (tag) => context.tags?.some((known) => known.tag === tag) !== true,
  );
  if (context.tags !== undefined && unknown.length > 0)
    return `not tags of the taxonomy: ${unknown.join(", ")}`;
  const calibrated = calibrateJudges(context.report, [label]);
  if (calibrated.kind === "invalid") return calibrated.reason;
  return calibrated.calibration.matched === 1
    ? undefined
    : `${context.file} has no verdict of ${label.judge} on ${label.runId}`;
}

/** Where the run of a label is on its page. */
function fragmentOf(report: EvalRunReport, runId: string): string {
  const [name, run] = [
    runId.slice(0, runId.lastIndexOf("#")),
    Number(runId.slice(runId.lastIndexOf("#") + 1)),
  ];
  const index = report.cases.findIndex((found) => found.name === name);
  return index < 0 ? "cases" : runAnchor(index, run);
}

export function saveLabel(context: SaveLabelContext, form: URLSearchParams): EvalUiResponse {
  const read = evalLabelOf(labelValueOf(form));
  if (read.kind === "invalid") return textResponse(400, `not a label: ${read.reason}`);
  const misfit = misfitOf(context, read.label);
  if (misfit !== undefined) return textResponse(400, misfit);
  const labels = suiteLabelsOf(context.labelsFolder, context.report.suite);
  if (labels.kind === "invalid")
    return textResponse(
      409,
      `${labels.file} cannot be read, so it is not rewritten: ${labels.reason}`,
    );
  saveSuiteLabel(labels.file, read.label);
  return seeOther(context.runPage(fragmentOf(context.report, read.label.runId)));
}
