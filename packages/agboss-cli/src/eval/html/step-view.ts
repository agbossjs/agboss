import type {
  EvalJudgeVerdictTrace,
  EvalModelCallTrace,
  EvalStepTrace,
  EvalToolCallTrace,
} from "@agboss/core/eval";
import { durationText, usdText } from "./format.js";
import { element, type HtmlChild, type HtmlElement } from "./html.js";
import { valueView } from "./value-view.js";

/**
 * One step of a run's timeline (#397 PR 2): the visit — its component, kind, visit / copy / item,
 * input hash, spend and time — then its model calls with tokens and cost, its tool calls with input
 * and output, validation attempts, guardrail decisions, judge verdicts and a failure a side path took.
 */

function visitLine(step: EvalStepTrace): string {
  const parts = [
    `visit ${String(step.visitNumber)}`,
    step.copyNumber > 1 ? `copy ${String(step.copyNumber)}` : "",
    step.itemIndex === undefined ? "" : `item ${String(step.itemIndex)}`,
    `input ${step.inputHash.slice(0, 10)}`,
    usdText(step.spentUsd),
    durationText(step.startedAt, step.endedAt),
  ];
  return parts.filter((part) => part !== "").join(" · ");
}

function modelCallsTable(calls: readonly EvalModelCallTrace[]): HtmlElement | undefined {
  if (calls.length === 0) return undefined;
  const columns = ["Model", "Caller", "In", "Out", "Cached", "Cost"];
  const row = (call: EvalModelCallTrace): HtmlElement =>
    element("tr", {}, [
      element("th", { scope: "row" }, [call.model]),
      element("td", {}, [call.caller]),
      ...[call.inputTokens, call.outputTokens, call.cacheReadTokens].map((tokens) =>
        element("td", { class: "number" }, [String(tokens)]),
      ),
      element("td", { class: "number" }, [usdText(call.costUsd)]),
    ]);
  return element("div", { class: "table-scroll" }, [
    element("table", {}, [
      element("caption", {}, ["Model calls"]),
      element("thead", {}, [
        element(
          "tr",
          {},
          columns.map((title) => element("th", { scope: "col" }, [title])),
        ),
      ]),
      element("tbody", {}, calls.map(row)),
    ]),
  ]);
}

function toolCallView(call: EvalToolCallTrace): HtmlElement {
  const notes = [
    call.toolLoopIteration === undefined ? "" : `model call ${String(call.toolLoopIteration)}`,
    call.isResultTruncated ? "result truncated for the model" : "",
  ].filter((note) => note !== "");
  return element("details", { class: "tool-call" }, [
    element("summary", {}, [
      element("code", {}, [call.tool]),
      " ",
      element("span", { class: `status status-call-${call.status}` }, [call.status]),
      notes.length === 0 ? "" : ` · ${notes.join(" · ")}`,
    ]),
    valueView("Input", call.input),
    call.output !== undefined && valueView("Output", call.output),
    call.error !== undefined && errorLine(call.error.code, call.error.message),
  ]);
}

const verdictText = (verdict: EvalJudgeVerdictTrace): string => {
  const metrics = Object.entries(verdict.metrics ?? {}).map(
    ([name, value]) => `${name}: ${String(value)}`,
  );
  return [
    `${verdict.judge} on reply ${String(verdict.attempt + 1)}: ${verdict.passed ? "passed" : "failed"}`,
    verdict.reason ?? "",
    metrics.join(", "),
  ]
    .filter((part) => part !== "")
    .join(" — ");
};

/** A failure: its code, then its message. */
export const errorLine = (code: string, message: string): HtmlElement =>
  element("p", { class: "run-error" }, [element("code", {}, [code]), ` ${message}`]);

/** A titled list, left out when empty. */
export function listOf(title: string, items: readonly HtmlChild[]): HtmlElement | undefined {
  if (items.length === 0) return undefined;
  return element("div", { class: "step-part" }, [
    element("p", { class: "step-part-title" }, [title]),
    element(
      "ul",
      {},
      items.map((item) => element("li", {}, [item])),
    ),
  ]);
}

/** One step as a list item; `id` anchors it for the unstable-case link. */
export function stepView(step: EvalStepTrace, id?: string): HtmlElement {
  return element("li", { class: "step", id }, [
    element("p", { class: "step-head" }, [
      element("span", { class: "kind" }, [step.kind]),
      " ",
      element("strong", {}, [step.nodeId]),
      ` · ${visitLine(step)}`,
    ]),
    step.validationAttempts > 0 &&
      element("p", { class: "muted" }, [
        `${String(step.validationAttempts)} answer(s) or tool argument(s) failed validation and were sent back`,
      ]),
    modelCallsTable(step.modelCalls),
    ...step.toolCalls.map(toolCallView),
    listOf(
      "Guardrails",
      step.guardrailDecisions.map(
        (decision) =>
          `${decision.guardrail} (${decision.side}): ${decision.isBlocked ? "blocked" : "passed"}, p = ${String(decision.probability)}`,
      ),
    ),
    listOf("Judges", step.judgeVerdicts.map(verdictText)),
    step.error !== undefined && errorLine(step.error.code, step.error.message),
  ]);
}
