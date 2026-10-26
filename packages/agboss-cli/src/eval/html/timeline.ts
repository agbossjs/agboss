import type { EvalChildTrace, EvalExecutionTrace } from "@agboss/core/eval";
import { element, type HtmlElement } from "./html.js";
import { errorLine, listOf, stepView } from "./step-view.js";
import { valueView } from "./value-view.js";

/**
 * A run's timeline (#397 PR 2): the case's last execution step by step, then the failures a side
 * path took, its pauses and undo actions, its child executions nested the same way, and the output
 * it finished with — what the run artifact's `trace` holds.
 */

/** The most steps of one execution the page lists (`maxSteps` bounds them in practice). */
export const MAX_STEPS_SHOWN = 200;

function partsOf(trace: EvalExecutionTrace): (HtmlElement | undefined)[] {
  return [
    listOf(
      "Failures a side path took",
      trace.handledErrors.map(
        (handled) =>
          `${handled.at} → ${handled.by}: ${handled.error.code} ${handled.error.message}`,
      ),
    ),
    listOf(
      "Pauses",
      trace.pauses.map(
        (pause) =>
          `${pause.nodeId} asked ${pause.role}: ${pause.resolution}${pause.responder === undefined ? "" : ` by ${pause.responder}`}${pause.decision === undefined ? "" : ` — ${JSON.stringify(pause.decision)}`}`,
      ),
    ),
    listOf(
      "Undo actions",
      trace.compensations.map(
        (undo) =>
          `${undo.compensator} undid ${undo.compensated} (${undo.reason}): ${undo.status}${undo.error === undefined ? "" : ` — ${undo.error.message}`}`,
      ),
    ),
  ];
}

function childView(child: EvalChildTrace): HtmlElement {
  const item = child.itemIndex === undefined ? "" : ` · item ${String(child.itemIndex)}`;
  return element("details", { class: "child" }, [
    element("summary", {}, [
      element("strong", {}, [child.workflow]),
      ` · ${child.status}${item} · launched by ${child.launchedBy}`,
    ]),
    child.error !== undefined && errorLine(child.error.code, child.error.message),
    ...executionViewOf(child),
  ]);
}

/** An execution's steps and parts; `anchorOf(index)` anchors the root's steps. */
function executionViewOf(
  trace: EvalExecutionTrace,
  anchorOf?: (index: number) => string,
): (HtmlElement | undefined)[] {
  const shown = trace.steps.slice(0, MAX_STEPS_SHOWN);
  const hidden = trace.steps.length - shown.length;
  return [
    element(
      "ol",
      { class: "steps" },
      shown.map((step, index) => stepView(step, anchorOf?.(index))),
    ),
    hidden > 0 &&
      element("p", { class: "muted" }, [`${String(hidden)} more steps in the run artifact`]),
    ...partsOf(trace),
    trace.children.length > 0 &&
      element("div", { class: "children" }, [
        element("p", { class: "step-part-title" }, ["Child executions"]),
        ...trace.children.map(childView),
      ]),
    trace.finish !== undefined && valueView(`Output at ${trace.finish}`, trace.output ?? null),
  ].map((part) => (part === false ? undefined : part));
}

/** The timeline of a run, its steps anchored by `anchorOf`. */
export function timelineOf(
  trace: EvalExecutionTrace,
  anchorOf: (index: number) => string,
): HtmlElement {
  return element("div", { class: "timeline" }, [
    element("p", { class: "step-part-title" }, [`Timeline · ${trace.path.join(" → ")}`]),
    ...executionViewOf(trace, anchorOf),
  ]);
}
