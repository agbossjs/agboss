import type { JudgeMetrics } from "../../components/judge-decorators.js";

/**
 * `agboss eval calibrate` (#396 PR 4, S2 C4–C5, Q8): a model judge's verdicts in a run artifact read
 * against people's labels of the same runs — pairwise Cohen's κ between the judge and each labeler
 * and between labelers, a confusion matrix per labeler, and the disagreements grouped by the
 * judge's `metrics` keys (the rubric). Plain data: the CLI prints it and `--json` carries it.
 */

/**
 * One person's verdict on one judged run — a line of `eval/labels/<suite>.jsonl` (C4). `runId` is the
 * run as the artifact names it, `<case>#<run>` (`refund-within-policy#2`); `executionId` the run's
 * last execution, the one its judges judged. `passed` is what κ reads (C5); `score` (1–4) only feeds
 * the rubric view.
 */
export interface EvalLabel {
  readonly runId: string;
  readonly executionId: string;
  /** The judge whose verdict the label answers, by its `name`. */
  readonly judge: string;
  /** Who labelled it. */
  readonly labeler: string;
  readonly passed: boolean;
  /** 1 to 4: how good the answer is, for the rubric view only. */
  readonly score?: number;
  /** Why it failed, in the labeler's words (`invents-fee`). */
  readonly failureTags: readonly string[];
  readonly note?: string;
}

/** Two raters on the runs both rated: the judge (by its name) and a labeler, or two labelers. */
export interface EvalRaterAgreement {
  readonly raters: readonly [string, string];
  /** Runs both rated. */
  readonly n: number;
  /** The share they agreed on. */
  readonly observed: number;
  /** Cohen's κ; absent when chance agreement is 1 (both gave one verdict only). */
  readonly kappa?: number;
}

/** The judge against one labeler. */
export interface EvalConfusionMatrix {
  readonly labeler: string;
  readonly judgePassedLabelerPassed: number;
  readonly judgePassedLabelerFailed: number;
  readonly judgeFailedLabelerPassed: number;
  readonly judgeFailedLabelerFailed: number;
}

/** A run on which the judge and a labeler disagreed. */
export interface EvalDisagreement {
  readonly runId: string;
  readonly executionId: string;
  readonly labeler: string;
  readonly judgePassed: boolean;
  readonly metrics?: JudgeMetrics;
  readonly score?: number;
  readonly failureTags: readonly string[];
  readonly note?: string;
}

/** One value of a text or flag metric: how often the judge and a labeler disagreed and agreed on it. */
export interface EvalMetricValue {
  readonly value: string;
  readonly disagreements: number;
  readonly agreements: number;
}

/** One `metrics` key of the judge over the labelled runs: the rubric (S2 Q8). */
export interface EvalMetricGroup {
  readonly key: string;
  readonly disagreements: number;
  readonly agreements: number;
  /** A text or flag metric: its values, the most disagreed first. */
  readonly values?: readonly EvalMetricValue[];
  /** A numeric metric: its mean on the disagreements and on the agreements. */
  readonly mean?: { readonly disagreements?: number; readonly agreements?: number };
}

/** The labelers' scores (1–4, index 0 = score 1) on the runs the judge passed and failed (C5). */
export interface EvalScoreCounts {
  readonly judgePassed: readonly number[];
  readonly judgeFailed: readonly number[];
}

/** One judge of the run against its labels. */
export interface EvalJudgeCalibration {
  readonly judge: string;
  /** Judged runs with at least one label. */
  readonly n: number;
  readonly labelers: readonly string[];
  /** The judge with each labeler, then each pair of labelers. */
  readonly agreements: readonly EvalRaterAgreement[];
  readonly confusion: readonly EvalConfusionMatrix[];
  readonly disagreements: readonly EvalDisagreement[];
  readonly metrics: readonly EvalMetricGroup[];
  /** Only when a label has a `score`. */
  readonly scores?: EvalScoreCounts;
}

/** A run artifact against its labels. */
export interface EvalCalibration {
  readonly suite: string;
  /** Labels read, and those matched to a judge's verdict in this run. */
  readonly labels: number;
  readonly matched: number;
  /** Labels of executions this run does not have, or of a judge that gave no verdict on them. */
  readonly unmatched: number;
  readonly judges: readonly EvalJudgeCalibration[];
}
