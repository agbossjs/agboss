/**
 * A run compared with a baseline (#396 PR 3): `agboss eval run --baseline <run.json>` reads each
 * case against the same case of an earlier run artifact (a run of `main`, kept with `--report`).
 */

/** How one case compares with its baseline. */
export enum CaseComparison {
  /** pass^k on the baseline, not now: the only verdict `--fail-on-regression` fails on. */
  Regressed = "regressed",
  /** No pass@k on the baseline (every run failed), pass@k now. */
  Improved = "improved",
  /** Neither regressed nor improved. */
  Unchanged = "unchanged",
  /** pass@k without pass^k on the baseline: it flapped there too — quarantined, never a failure. */
  FlakyOnBaseline = "flaky-on-baseline",
  /** Not in the baseline. */
  New = "new",
  /** In the baseline, not in this run. */
  Removed = "removed",
  /** Its definition changed since the baseline (another `caseHash`): not compared. */
  Changed = "changed",
}

/** One case's runs that passed, of how many. */
export interface EvalCasePasses {
  readonly passed: number;
  readonly runs: number;
}

/** One case against its baseline. */
export interface EvalCaseComparison {
  readonly name: string;
  readonly comparison: CaseComparison;
  /** The baseline's passes; none for a new case. */
  readonly baseline?: EvalCasePasses;
  /** This run's passes; none for a removed case. */
  readonly candidate?: EvalCasePasses;
}

/** A whole run against its baseline: every case of either, this run's first, in order. */
export interface EvalRunComparison {
  /** The baseline file as given to `--baseline`. */
  readonly file: string;
  /** What the baseline ran on and when. */
  readonly configHash: string;
  readonly startedAt: string;
  readonly runs: number;
  readonly cases: readonly EvalCaseComparison[];
  /** The names of the cases that regressed. */
  readonly regressed: readonly string[];
}
