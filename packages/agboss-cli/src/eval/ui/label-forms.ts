import { CheckStatus, type EvalCaseReport, type EvalLabel, type EvalRunResult } from "agboss/eval";
import { TRAJECTORY_CHECK, type EvalFailureTag } from "agboss/internal";
import { element, type HtmlElement } from "../html/html.js";

/**
 * A run's label forms on `agboss eval ui`'s run page (#397 PR 4): for each judge's verdict on the
 * run, the labels people gave it and a form to give one — passed or failed, a score from 1 to 4
 * (optional, the rubric view's), failure tags from the project's taxonomy, a note, who labels.
 * Plain HTML forms, posted to the server with its token; the page works without its script.
 */

/** What a run's forms need: where they post, the token, the taxonomy, the labels so far. */
export interface LabelFormsContext {
  readonly action: string;
  readonly token: string;
  readonly labeler: string;
  readonly tags: readonly EvalFailureTag[];
  readonly labels: readonly EvalLabel[];
}

const hidden = (name: string, value: string): HtmlElement =>
  element("input", { type: "hidden", name, value });

const labelText = (label: EvalLabel): string =>
  [
    `${label.labeler}: ${label.passed ? "passed" : "failed"}`,
    label.score === undefined ? "" : `score ${String(label.score)}`,
    label.failureTags.join(", "),
    label.note ?? "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

function choice(
  name: string,
  value: string,
  label: string,
  id: string,
  isChecked = false,
): HtmlElement {
  return element("label", { class: "choice", for: id }, [
    element("input", {
      type: name === "failureTags" ? "checkbox" : "radio",
      name,
      value,
      id,
      required: name === "passed",
      checked: isChecked,
    }),
    ` ${label}`,
  ]);
}

function formOf(
  context: LabelFormsContext,
  runId: string,
  executionId: string,
  judge: string,
  id: string,
): HtmlElement {
  const scores = ["", "1", "2", "3", "4"].map((value) =>
    element("option", { value }, [value === "" ? "—" : value]),
  );
  return element("form", { method: "post", action: context.action, class: "label-form" }, [
    hidden("token", context.token),
    hidden("runId", runId),
    hidden("executionId", executionId),
    hidden("judge", judge),
    element("fieldset", {}, [
      element("legend", {}, [`Your verdict on ${judge}'s`]),
      choice("passed", "true", "passed", `${id}-passed`),
      choice("passed", "false", "failed", `${id}-failed`),
    ]),
    element("label", { for: `${id}-score` }, ["Score (1–4, optional) "]),
    element("select", { name: "score", id: `${id}-score` }, scores),
    context.tags.length > 0 &&
      element("fieldset", {}, [
        element("legend", {}, ["Failure tags"]),
        ...context.tags.map((tag, index) =>
          element("span", { title: tag.description }, [
            choice("failureTags", tag.tag, tag.tag, `${id}-tag-${String(index)}`),
          ]),
        ),
      ]),
    element("label", { for: `${id}-note` }, ["Note "]),
    element("input", { type: "text", name: "note", id: `${id}-note`, maxlength: 500 }),
    element("label", { for: `${id}-labeler` }, ["Labeler "]),
    element("input", {
      type: "text",
      name: "labeler",
      id: `${id}-labeler`,
      value: context.labeler,
      required: true,
      maxlength: 100,
    }),
    element("button", { type: "submit" }, ["Save label"]),
  ]);
}

/** The forms of one run: one per judge verdict it has; none for a run without an execution. */
export function labelFormsOf(
  context: LabelFormsContext,
  caseIndex: number,
  found: EvalCaseReport,
  result: EvalRunResult,
): HtmlElement | undefined {
  const { executionId } = result;
  if (executionId === undefined) return undefined;
  const runId = `${found.name}#${String(result.run)}`;
  const judged = result.checks.filter(
    (check) => check.check !== TRAJECTORY_CHECK && check.status !== CheckStatus.Skipped,
  );
  if (judged.length === 0) return undefined;
  return element(
    "div",
    { class: "labels" },
    judged.map((check, index) => {
      const given = context.labels.filter(
        (label) => label.executionId === executionId && label.judge === check.check,
      );
      const id = `label-${String(caseIndex + 1)}-${String(result.run)}-${String(index + 1)}`;
      return element("details", { class: "label-details", id }, [
        element("summary", {}, [
          `Label ${check.check}'s verdict (${check.status}) — ${String(given.length)} label(s)`,
        ]),
        given.length > 0 &&
          element(
            "ul",
            {},
            given.map((label) => element("li", {}, [labelText(label)])),
          ),
        formOf(context, runId, executionId, check.check, id),
      ]);
    }),
  );
}
