import type { EvalRunReport } from "agboss/internal";
import { durationText } from "./format.js";
import { element, type HtmlElement } from "./html.js";
import { factsOf } from "./sections.js";

/** The report's header (#397 PR 1): the suite and what it ran on, when and how. */
export const reportHeaderOf = (report: EvalRunReport): HtmlElement =>
  element("header", { class: "report-header" }, [
    element("p", { class: "eyebrow" }, ["AGBoss eval run"]),
    element("h1", {}, [report.suite]),
    factsOf([
      ["Application", `${report.application.name} ${report.application.version}`],
      ["Workflow", `${report.workflow.name} ${report.workflow.version}`],
      ["Config", report.configHash],
      ["Start", report.start],
      ["Environment", report.environment],
      ["Runs per case (k)", String(report.runs)],
      ["Cascade", report.cascade],
      ["Started", report.startedAt],
      ["Ended", report.endedAt],
      ["Took", durationText(report.startedAt, report.endedAt)],
    ]),
  ]);
