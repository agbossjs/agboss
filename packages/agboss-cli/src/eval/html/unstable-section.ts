import type { EvalRunReport } from "agboss/eval";
import { element } from "./html.js";
import { caseAnchor, sectionOf, type ReportSection } from "./sections.js";

/**
 * The unstable cases (#397 PR 1, S3): pass@k without pass^k — a check the model passes only
 * sometimes. Shown only when there are some.
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
                ]),
              ]
            : [],
        ),
      ),
    ]),
};
