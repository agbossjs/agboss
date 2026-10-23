import type { EvalCheckResult, EvalRunResult } from "agboss/eval";
import { attemptStatusOf } from "./attempts.js";
import { usdText } from "./format.js";
import { element, type HtmlElement } from "./html.js";
import { factsOf, runAnchor, stepAnchor } from "./sections.js";
import { timelineOf } from "./timeline.js";

/**
 * One run of a case, as the report opens it from its dot (#397 PR 1): its execution, the turn's
 * error when one could not end, every check with its status, reason, the check that skipped it, a
 * judge's metrics and spend, then its timeline and output (#397 PR 2, a version 2 artifact) — what
 * the artifact holds of the run, nothing more.
 */

/** Why a check failed or was skipped. */
function whyOf(check: EvalCheckResult): string {
  if (check.reason !== undefined) return check.reason;
  return check.skippedBy === undefined ? "" : `skipped: ${check.skippedBy} failed first`;
}

const metricsText = (check: EvalCheckResult): string =>
  Object.entries(check.metrics ?? {})
    .map(([name, value]) => `${name}: ${String(value)}`)
    .join(", ");

function checkRow(check: EvalCheckResult): HtmlElement {
  return element("tr", {}, [
    element("th", { scope: "row" }, [check.check]),
    element("td", {}, [
      element("span", { class: `status status-${check.status}` }, [check.status]),
    ]),
    element("td", {}, [whyOf(check)]),
    element("td", {}, [metricsText(check)]),
    element("td", { class: "number" }, [
      check.spentUsd === undefined ? "" : usdText(check.spentUsd),
    ]),
  ]);
}

function checksTable(result: EvalRunResult): HtmlElement {
  if (result.checks.length === 0)
    return element("p", { class: "muted" }, [
      "No checks ran: the run ended before its last turn did.",
    ]);
  const columns = ["Check", "Status", "Reason", "Metrics", "Spent"];
  return element("div", { class: "table-scroll" }, [
    element("table", {}, [
      element("caption", {}, [`Checks of run ${String(result.run)}, in order`]),
      element("thead", {}, [
        element(
          "tr",
          {},
          columns.map((title) => element("th", { scope: "col" }, [title])),
        ),
      ]),
      element("tbody", {}, result.checks.map(checkRow)),
    ]),
  ]);
}

/** The run's timeline, or why the page has none. */
function timelineViewOf(
  caseIndex: number,
  result: EvalRunResult,
  isTimelineShown: boolean,
): HtmlElement {
  if (result.trace === undefined)
    return element("p", { class: "muted" }, [
      "No timeline: the artifact holds none for this run (a version 1 artifact, or a turn that failed before its record).",
    ]);
  if (!isTimelineShown)
    return element("p", { class: "muted" }, [
      "Timeline left out to keep the page under its size bound: the run artifact keeps it.",
    ]);
  return timelineOf(result.trace, (index) => stepAnchor(caseIndex, result.run, index));
}

/** The run's `<details>`, opened by its dot. */
export function runDetails(
  caseIndex: number,
  result: EvalRunResult,
  isTimelineShown: boolean,
): HtmlElement {
  const status = attemptStatusOf(result);
  const { error } = result;
  return element("details", { class: "run", id: runAnchor(caseIndex, result.run) }, [
    element("summary", {}, [
      `Run ${String(result.run)} — `,
      element("span", { class: `status status-${status}` }, [status]),
      ` · ${usdText(result.spentUsd)}`,
    ]),
    factsOf([
      ["Execution", result.executionId ?? ""],
      ["Thread", result.threadId],
      ["Finish", result.finish ?? ""],
    ]),
    error !== undefined &&
      element("p", { class: "run-error" }, [
        element("code", {}, [error.code]),
        ` ${error.message}`,
      ]),
    checksTable(result),
    timelineViewOf(caseIndex, result, isTimelineShown),
  ]);
}
