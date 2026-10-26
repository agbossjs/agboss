import {
  CheckStatus,
  type EvalCaseReport,
  type EvalRunReport,
  type EvalRunResult,
} from "@agboss/core/eval";
import type { CommandContext } from "../cli/context.js";

/**
 * What `agboss eval run` prints (#396 PR 2): a line on the suite and what it ran on, one row per
 * case — pass@k, pass^k, each run as ✓ / ✗, the first failure, "unstable" for pass@k without
 * pass^k — and the totals.
 */

const yes = (value: boolean): string => (value ? "yes" : "no");

/** The first reason a run failed: its turn's error, or its first failed check. */
function firstFailureOf(result: EvalRunResult): string | undefined {
  if (result.error !== undefined) return `${result.error.code}: ${result.error.message}`;
  const failed = result.checks.find((check) => check.status === CheckStatus.Failed);
  return failed === undefined ? undefined : `${failed.check}: ${failed.reason ?? "failed"}`;
}

/** The first reason one of a case's runs failed, `run 2: …`; empty when every run passed. */
export function firstFailureOfCase(found: EvalCaseReport): string {
  for (const result of found.runResults) {
    const why = firstFailureOf(result);
    if (why !== undefined) return `run ${String(result.run)}: ${why}`;
  }
  return "";
}

/** The header: the suite, its workflow, the config it ran on, cases × runs, the environment. */
export const headerOf = (report: EvalRunReport): string =>
  `${report.suite} · ${report.workflow.name} ${report.workflow.version} · config ${report.configHash.slice(0, 6)} · ${String(report.cases.length)} cases × ${String(report.runs)} runs · env ${report.environment}`;

/** One row per case, under a header row; columns padded to the longest value. */
export function caseLines(report: EvalRunReport): string[] {
  const k = String(report.runs);
  const rows = report.cases.map((found) => [
    found.name,
    yes(found.passAtK),
    yes(found.passHatK),
    found.runResults.map((result) => (result.passed ? "✓" : "✗")).join(""),
    [firstFailureOfCase(found), found.isUnstable ? "unstable" : ""]
      .filter((part) => part !== "")
      .join("   "),
  ]);
  const header = ["case", `pass@${k}`, `pass^${k}`, "runs", "first failure"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  return [header, ...rows].map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

/** The totals line. */
export function summaryLine(report: EvalRunReport): string {
  const { summary, runs } = report;
  const k = String(runs);
  const of = `/${String(summary.cases)}`;
  return [
    `pass@${k} ${String(summary.passAtK)}${of}`,
    `pass^${k} ${String(summary.passHatK)}${of}`,
    `unstable ${String(summary.unstable)}`,
    `judge calls ${String(summary.judgeCalls)} (${String(summary.skippedByCascade)} skipped by the cascade)`,
    `spent $${report.spend.totalUsd.toFixed(4)}`,
  ].join(" · ");
}

/** The whole table — header, one row per case, totals — as `eval run` and `eval show` print it. */
export function printRunTable(context: CommandContext, report: EvalRunReport): void {
  [headerOf(report), ...caseLines(report), summaryLine(report)].forEach(context.say);
}
