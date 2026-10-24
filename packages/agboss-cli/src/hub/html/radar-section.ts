import { element, type HtmlElement } from "../../eval/html/html.js";
import { usdText } from "../../eval/html/format.js";
import { sectionOf } from "../../eval/html/sections.js";
import { RADAR_MIN_CALLS, RADAR_MIN_STABILITY, type RadarStep } from "../crystallization-radar.js";

/**
 * The Crystallization Radar's section (#401 PR 5): every model step of the records ranked by spend ×
 * stability, candidates first — each with its calls, spend, stability over its repeated inputs, its
 * workflow's pass^k and the executions behind it.
 */

const percentText = (share: number | undefined): string =>
  share === undefined ? "—" : `${(share * 100).toFixed(1)}%`;

const passHatKText = (passHatK: boolean | undefined): string => {
  if (passHatK === undefined) return "no eval";
  return passHatK ? "yes" : "no";
};

function rowOf(step: RadarStep, rank: number): HtmlElement {
  const cells = [
    String(rank + 1),
    `${step.application} · ${step.workflow}`,
    `${step.component} (${step.kind})`,
    String(step.calls),
    usdText(step.spendUsd),
    `${percentText(step.stability)} over ${String(step.repeatedInputs)} inputs (${String(step.repeatedCalls)} calls)`,
    passHatKText(step.passHatK),
    usdText(step.score),
  ];
  return element("tr", step.isCandidate ? { class: "radar-candidate" } : {}, [
    ...cells.map((cell, index) =>
      element("td", index === 3 || index === 4 || index === 7 ? { class: "number" } : {}, [cell]),
    ),
    element("td", {}, [
      element("span", { class: step.isCandidate ? "badge badge-passed" : "badge badge-neutral" }, [
        step.isCandidate ? "candidate" : "not yet",
      ]),
    ]),
    element("td", {}, [
      element("details", {}, [
        element("summary", {}, [`${String(step.executions.length)} executions`]),
        element(
          "ul",
          { class: "parts" },
          step.executions.map((id) => element("li", {}, [element("code", {}, [id])])),
        ),
      ]),
    ]),
  ]);
}

const HEAD = [
  "#",
  "workflow",
  "step",
  "calls",
  "spend",
  "stability",
  "pass^k",
  "score",
  "",
  "records",
];

/** The radar's section. */
export function radarSectionOf(radar: readonly RadarStep[]): HtmlElement {
  const rule = `A candidate has at least ${String(RADAR_MIN_CALLS)} calls, gives the same decision for the same input at least ${percentText(RADAR_MIN_STABILITY)} of the time, and passes every case of its workflow's eval suites where there are any. Score = spend × stability.`;
  if (radar.length === 0)
    return sectionOf("radar", "Crystallization radar", [
      element("p", { class: "muted" }, ["No model step in the records."]),
    ]);
  return sectionOf("radar", "Crystallization radar", [
    element("p", { class: "muted" }, [rule]),
    element("div", { class: "table-scroll" }, [
      element("table", {}, [
        element("caption", {}, ["Model steps worth turning into code, ranked"]),
        element("thead", {}, [
          element(
            "tr",
            {},
            HEAD.map((cell) => element("th", { scope: "col" }, [cell])),
          ),
        ]),
        element("tbody", {}, radar.map(rowOf)),
      ]),
    ]),
  ]);
}
