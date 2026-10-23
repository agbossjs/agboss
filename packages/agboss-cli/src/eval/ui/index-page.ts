import type { EvalCaseReport } from "agboss/eval";
import { ATTEMPT_SYMBOLS, attemptStatusOf } from "../html/attempts.js";
import { htmlDocumentOf } from "../html/document.js";
import { shareText } from "../html/format.js";
import { element, renderHtml, type HtmlElement } from "../html/html.js";
import { factsOf, runAnchor, sectionOf } from "../html/sections.js";
import type { RunFile } from "./run-folder.js";

/**
 * The first page of `agboss eval ui` (#397 PR 3): the folder's runs, newest first — each with what
 * it ran on, its pass rates and, per case, a dot per attempt linked to that run's page at that
 * attempt — then the files that are not run artifacts, with why.
 */

/** Where a run's page is, for the token the server was started with. */
export type RunHref = (file: string, fragment?: string) => string;

function attemptsOf(
  found: EvalCaseReport,
  caseIndex: number,
  href: (fragment: string) => string,
): HtmlElement {
  return element("li", { class: "index-case" }, [
    element("span", { class: "index-case-name" }, [found.name]),
    element(
      "ol",
      { class: "attempts", "aria-label": `Runs of ${found.name}` },
      found.runResults.map((result) => {
        const status = attemptStatusOf(result);
        const label = `${found.name}, run ${String(result.run)}: ${status}`;
        return element("li", {}, [
          element(
            "a",
            {
              class: `dot dot-${status}`,
              href: href(runAnchor(caseIndex, result.run)),
              title: label,
              "aria-label": label,
            },
            [ATTEMPT_SYMBOLS[status]],
          ),
        ]);
      }),
    ),
  ]);
}

function runEntry(found: Extract<RunFile, { kind: "run" }>, runHref: RunHref): HtmlElement {
  const { report } = found;
  const k = String(report.runs);
  const { summary } = report;
  return element("li", { class: "case" }, [
    element("article", {}, [
      element("h3", {}, [element("a", { href: runHref(found.file) }, [report.suite])]),
      factsOf([
        ["File", found.file],
        ["Workflow", `${report.workflow.name} ${report.workflow.version}`],
        ["Config", report.configHash],
        ["Environment", report.environment],
        ["Started", report.startedAt],
        [`pass@${k}`, shareText(summary.passAtK, summary.cases)],
        [`pass^${k}`, shareText(summary.passHatK, summary.cases)],
        ["Unstable", String(summary.unstable)],
        [
          "Regressed",
          report.baseline === undefined ? "" : report.baseline.regressed.join(", ") || "none",
        ],
      ]),
      element(
        "ul",
        { class: "index-cases" },
        report.cases.map((each, index) =>
          attemptsOf(each, index, (fragment) => runHref(found.file, fragment)),
        ),
      ),
    ]),
  ]);
}

/** The page: the folder's runs and the files it could not read. */
export function indexPageOf(folder: string, files: readonly RunFile[], runHref: RunHref): string {
  const runs = files.filter((found) => found.kind === "run");
  const invalid = files.filter((found) => found.kind === "invalid");
  const header = element("header", { class: "report-header" }, [
    element("p", { class: "eyebrow" }, ["AGBoss eval ui"]),
    element("h1", {}, ["Eval runs"]),
    element("p", { class: "muted" }, [`${folder} · ${String(runs.length)} run artifact(s)`]),
  ]);
  const main = element("main", {}, [
    sectionOf("runs", "Runs", [
      runs.length === 0
        ? element("p", { class: "muted" }, [
            "No run artifact here yet: write one with agboss eval run --report <file> into this folder.",
          ])
        : element(
            "ol",
            { class: "cases" },
            runs.map((found) => runEntry(found, runHref)),
          ),
    ]),
    invalid.length > 0 &&
      sectionOf("not-runs", "Files that are not run artifacts", [
        element(
          "ul",
          {},
          invalid.map((found) =>
            element("li", {}, [element("code", {}, [found.file]), ` — ${found.reason}`]),
          ),
        ),
      ]),
  ]);
  return htmlDocumentOf("Eval runs", [header, main].map(renderHtml).join(""));
}
