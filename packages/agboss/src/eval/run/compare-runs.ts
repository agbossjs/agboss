import {
  CaseComparison,
  type EvalCaseComparison,
  type EvalCasePasses,
  type EvalRunComparison,
} from "./comparison.js";
import type { EvalCaseReport, EvalRunReport } from "./report.js";

/**
 * `--baseline` (#396 PR 3, S2 Q6–Q7): each case of a run read against the same case of a baseline
 * artifact, by name. A changed definition (`caseHash`) is `Changed` and not compared; a case that
 * flapped on the baseline (pass@k without pass^k) is `FlakyOnBaseline` — quarantined, never a
 * regression; `Regressed` = pass^k on the baseline and not now; `Improved` = no pass@k on the
 * baseline and pass@k now.
 */

const passesOf = (found: EvalCaseReport): EvalCasePasses => ({
  passed: found.passed,
  runs: found.runs,
});

/** The verdict of a case present in both runs. */
function verdictOf(baseline: EvalCaseReport, candidate: EvalCaseReport): CaseComparison {
  if (baseline.caseHash !== candidate.caseHash) return CaseComparison.Changed;
  if (baseline.isUnstable) return CaseComparison.FlakyOnBaseline;
  if (baseline.passHatK && !candidate.passHatK) return CaseComparison.Regressed;
  if (!baseline.passAtK && candidate.passAtK) return CaseComparison.Improved;
  return CaseComparison.Unchanged;
}

function caseComparisonOf(
  candidate: EvalCaseReport,
  baseline: EvalCaseReport | undefined,
): EvalCaseComparison {
  const { name } = candidate;
  if (baseline === undefined)
    return { name, comparison: CaseComparison.New, candidate: passesOf(candidate) };
  return {
    name,
    comparison: verdictOf(baseline, candidate),
    baseline: passesOf(baseline),
    candidate: passesOf(candidate),
  };
}

/** A run against its baseline (`file`: as `--baseline` gave it): every case of either. */
export function compareEvalRuns(
  baseline: EvalRunReport,
  candidate: EvalRunReport,
  file: string,
): EvalRunComparison {
  const before = new Map(baseline.cases.map((found) => [found.name, found]));
  const now = new Set(candidate.cases.map((found) => found.name));
  const cases: EvalCaseComparison[] = [
    ...candidate.cases.map((found) => caseComparisonOf(found, before.get(found.name))),
    ...baseline.cases
      .filter((found) => !now.has(found.name))
      .map((found) => ({
        name: found.name,
        comparison: CaseComparison.Removed,
        baseline: passesOf(found),
      })),
  ];
  return {
    file,
    configHash: baseline.configHash,
    startedAt: baseline.startedAt,
    runs: baseline.runs,
    cases,
    regressed: cases
      .filter((found) => found.comparison === CaseComparison.Regressed)
      .map((found) => found.name),
  };
}
