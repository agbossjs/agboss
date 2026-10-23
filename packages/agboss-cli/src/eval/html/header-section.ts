import type { EvalRunReport } from "agboss/eval";
import { durationText } from "./format.js";
import { element, type HtmlElement } from "./html.js";
import { factsOf } from "./sections.js";

/**
 * The report's header (#397 PR 1): the suite and what it ran on, when and how — with a version 3
 * artifact (PR 3) also the profile, the AGBoss version, the PII policies that masked it and the
 * model of every agent and model router.
 */

const modelsText = (report: EvalRunReport): string =>
  (report.models ?? []).map((use) => `${use.component}: ${use.model} (${use.provider})`).join("; ");

export const reportHeaderOf = (report: EvalRunReport, nav?: HtmlElement): HtmlElement =>
  element("header", { class: "report-header" }, [
    nav,
    element("p", { class: "eyebrow" }, ["AGBoss eval run"]),
    element("h1", {}, [report.suite]),
    factsOf([
      ["Application", `${report.application.name} ${report.application.version}`],
      ["Workflow", `${report.workflow.name} ${report.workflow.version}`],
      ["Config", report.configHash],
      ["Profile", report.profile ?? (report.agbossVersion === undefined ? "" : "none")],
      ["Start", report.start],
      ["Environment", report.environment],
      ["Runs per case (k)", String(report.runs)],
      ["Cascade", report.cascade],
      ["Started", report.startedAt],
      ["Ended", report.endedAt],
      ["Took", durationText(report.startedAt, report.endedAt)],
      ["AGBoss", report.agbossVersion ?? ""],
      [
        "Masked by",
        (report.piiPolicies ?? []).join(", ") ||
          (report.piiPolicies === undefined ? "" : "no PII policy"),
      ],
      ["Models", modelsText(report)],
    ]),
  ]);
