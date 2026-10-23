import type { JudgeMetrics } from "../../components/judge-decorators.js";
import { CheckStatus } from "../suite/checks.js";
import { isJudgeCheckName, type EvalRunReport } from "../run/report.js";
import type { EvalLabel } from "./calibration.js";

/**
 * The judges' verdicts of a run artifact, by the execution they judged, and the labels matched to
 * them (#396 PR 4). A judge check that was skipped gave no verdict; a label of an execution the run
 * does not have (a labels file grows over many runs) or of a judge that gave none is unmatched — it
 * is counted, never an error. A label whose `runId` is not its execution's run in this artifact is.
 */

/** One judge's verdict on one run. */
export interface JudgedRun {
  readonly runId: string;
  readonly executionId: string;
  readonly judge: string;
  readonly passed: boolean;
  readonly metrics?: JudgeMetrics;
}

/** A label and the judge's verdict it answers. */
export interface MatchedLabel {
  readonly label: EvalLabel;
  readonly verdict: JudgedRun;
}

/** Matched labels, how many were not, and the judges in the artifact's order. */
export type LabelsMatch =
  | {
      readonly kind: "matched";
      readonly matched: readonly MatchedLabel[];
      readonly unmatched: number;
      readonly judges: readonly string[];
    }
  | { readonly kind: "invalid"; readonly reason: string };

const keyOf = (executionId: string, judge: string): string => JSON.stringify([executionId, judge]);

interface VerdictIndex {
  readonly verdicts: ReadonlyMap<string, JudgedRun>;
  readonly runIds: ReadonlyMap<string, string>;
  readonly judges: readonly string[];
}

function indexOf(report: EvalRunReport): VerdictIndex {
  const verdicts = new Map<string, JudgedRun>();
  const runIds = new Map<string, string>();
  const judges = new Set<string>();
  for (const found of report.cases)
    for (const result of found.runResults) {
      const { executionId } = result;
      if (executionId === undefined) continue;
      const runId = `${found.name}#${String(result.run)}`;
      runIds.set(executionId, runId);
      for (const check of result.checks) {
        if (!isJudgeCheckName(check.check) || check.status === CheckStatus.Skipped) continue;
        judges.add(check.check);
        const { metrics } = check;
        const passed = check.status === CheckStatus.Passed;
        const verdict = { runId, executionId, judge: check.check, passed };
        verdicts.set(
          keyOf(executionId, check.check),
          metrics === undefined ? verdict : { ...verdict, metrics },
        );
      }
    }
  return { verdicts, runIds, judges: [...judges] };
}

/** The labels of `labels` matched to the judges' verdicts of `report`. */
export function matchLabels(report: EvalRunReport, labels: readonly EvalLabel[]): LabelsMatch {
  const index = indexOf(report);
  const matched: MatchedLabel[] = [];
  let unmatched = 0;
  for (const label of labels) {
    const runId = index.runIds.get(label.executionId);
    if (runId !== undefined && runId !== label.runId)
      return {
        kind: "invalid",
        reason: `the label by ${label.labeler} names run ${label.runId}, but ${label.executionId} is ${runId} in this run`,
      };
    const verdict = index.verdicts.get(keyOf(label.executionId, label.judge));
    if (verdict === undefined) unmatched += 1;
    else matched.push({ label, verdict });
  }
  return { kind: "matched", matched, unmatched, judges: index.judges };
}
