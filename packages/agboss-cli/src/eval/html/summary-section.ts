import type { EvalRunReport } from "@agboss/core/eval";
import { shareText, usdText } from "./format.js";
import { element } from "./html.js";
import { sectionOf, type ReportSection } from "./sections.js";

/** One figure of the summary: its label, value and what it counts. */
interface SummaryTile {
  readonly label: string;
  readonly value: string;
  readonly note: string;
}

function tilesOf(report: EvalRunReport): readonly SummaryTile[] {
  const { summary, runs } = report;
  const k = String(runs);
  return [
    {
      label: `pass@${k}`,
      value: shareText(summary.passAtK, summary.cases),
      note: "cases that passed at least once",
    },
    {
      label: `pass^${k}`,
      value: shareText(summary.passHatK, summary.cases),
      note: "cases that passed every run",
    },
    { label: "Cases", value: String(summary.cases), note: `each run ${k} times` },
    { label: "Attempts", value: String(summary.cases * runs), note: "runs of every case" },
    { label: "Unstable", value: String(summary.unstable), note: `pass@${k} without pass^${k}` },
    {
      label: "Judge calls",
      value: String(summary.judgeCalls),
      note: `${String(summary.skippedByCascade)} checks skipped by the cascade`,
    },
    { label: "Spent", value: usdText(report.spend.totalUsd), note: "the turns and the judges" },
  ];
}

/** The summary (#397 PR 1): pass@k, pass^k, cases, attempts, unstable, judge calls, spend. */
export const SUMMARY_SECTION: ReportSection = {
  isShownFor: () => true,
  render: (report: EvalRunReport) =>
    sectionOf("summary", "Summary", [
      element(
        "ul",
        { class: "tiles" },
        tilesOf(report).map((tile) =>
          element("li", { class: "tile" }, [
            element("span", { class: "tile-label" }, [tile.label]),
            element("span", { class: "tile-value" }, [tile.value]),
            element("span", { class: "tile-note" }, [tile.note]),
          ]),
        ),
      ),
    ]),
};
