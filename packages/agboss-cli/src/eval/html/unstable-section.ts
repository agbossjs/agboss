import type { EvalCaseReport, EvalRunReport } from "agboss/eval";
import { attemptDivergenceOf, AttemptDivergenceReason } from "agboss/internal";
import { element, type HtmlChild } from "./html.js";
import { caseAnchor, sectionOf, stepAnchor, type ReportSection } from "./sections.js";

/** What the runs did differently at the step where they part ways. */
const REASON_TEXT: Readonly<Record<AttemptDivergenceReason, string>> = {
  [AttemptDivergenceReason.NextStep]: "the runs went on to different nodes after it",
  [AttemptDivergenceReason.Input]: "it read a different input",
  [AttemptDivergenceReason.Verdicts]: "the same input, other judge verdicts or guardrail decisions",
  [AttemptDivergenceReason.ToolCalls]: "the same input, other tool calls",
  [AttemptDivergenceReason.Length]: "some runs ended after it, others went on",
  [AttemptDivergenceReason.Output]: "the same steps, another output",
};

/** Where the case's attempts part ways (#397 PR 2), linked to that step of its first run. */
function divergenceOf(found: EvalCaseReport, index: number): HtmlChild[] {
  const divergence = attemptDivergenceOf(found);
  if (divergence === undefined) return [" — its runs' timelines are not comparable"];
  const [first] = divergence.runs;
  const href = `#${stepAnchor(index, first ?? 1, divergence.stepIndex)}`;
  return [
    " — the attempts part ways at ",
    element("a", { href, "data-opens": true }, [divergence.nodeId]),
    ` (visit ${String(divergence.visitNumber)}): ${REASON_TEXT[divergence.reason]}`,
  ];
}

/**
 * The unstable cases (#397 PR 1, S3): pass@k without pass^k — a check the model passes only
 * sometimes — each with the node where its attempts part ways (PR 2). Shown only when there are some.
 */
export const UNSTABLE_SECTION: ReportSection = {
  isShownFor: (report) => report.cases.some((found) => found.isUnstable),
  render: (report: EvalRunReport) =>
    sectionOf("unstable", "Unstable cases", [
      element("p", {}, [
        `Each passed at least once in ${String(report.runs)} runs, but not every time. Do not grow the prompt: move the check into deterministic code — a tool interceptor, a code guardrail, a code router or arbiter, an action.`,
      ]),
      element(
        "ul",
        { class: "unstable-list" },
        report.cases.flatMap((found, index) =>
          found.isUnstable
            ? [
                element("li", {}, [
                  element("a", { href: `#${caseAnchor(index)}` }, [found.name]),
                  ` — ${String(found.passed)} of ${String(found.runs)} runs passed`,
                  ...divergenceOf(found, index),
                ]),
              ]
            : [],
        ),
      ),
    ]),
};
