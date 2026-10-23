import type { EvalRunReport } from "../run/report.js";
import type {
  EvalCalibration,
  EvalConfusionMatrix,
  EvalDisagreement,
  EvalJudgeCalibration,
  EvalLabel,
  EvalRaterAgreement,
} from "./calibration.js";
import { cohenKappa, observedAgreement, type RatedPair } from "./kappa.js";
import { metricGroupsOf, scoreCountsOf } from "./rubric.js";
import { matchLabels, type MatchedLabel } from "./verdicts.js";

/**
 * `agboss eval calibrate` (#396 PR 4, S2 Q8): each judge of a run artifact against its labels —
 * pairwise Cohen's κ between the judge and each labeler, then between every two labelers on the
 * runs both labelled, a confusion matrix per labeler, the disagreements and the rubric view.
 */

/** A calibration, or why the labels do not fit the run. */
export type EvalCalibrationResult =
  | { readonly kind: "calibrated"; readonly calibration: EvalCalibration }
  | { readonly kind: "invalid"; readonly reason: string };

function agreementOf(
  raters: readonly [string, string],
  pairs: readonly RatedPair[],
): EvalRaterAgreement {
  const kappa = cohenKappa(pairs);
  const agreement = { raters, n: pairs.length, observed: observedAgreement(pairs) };
  return kappa === undefined ? agreement : { ...agreement, kappa };
}

/** Two labelers on the runs both labelled for this judge. */
function labelersAgreementOf(
  pairs: readonly MatchedLabel[],
  first: string,
  second: string,
): EvalRaterAgreement {
  const byFirst = new Map(
    pairs
      .filter(({ label }) => label.labeler === first)
      .map(({ label }) => [label.executionId, label.passed]),
  );
  const rated = pairs.flatMap(({ label }): RatedPair[] => {
    const theirs = byFirst.get(label.executionId);
    return label.labeler === second && theirs !== undefined ? [[theirs, label.passed]] : [];
  });
  return agreementOf([first, second], rated);
}

function confusionOf(pairs: readonly MatchedLabel[], labeler: string): EvalConfusionMatrix {
  const own = pairs.filter(({ label }) => label.labeler === labeler);
  const count = (judgePassed: boolean, labelerPassed: boolean): number =>
    own.filter(
      ({ label, verdict }) => verdict.passed === judgePassed && label.passed === labelerPassed,
    ).length;
  return {
    labeler,
    judgePassedLabelerPassed: count(true, true),
    judgePassedLabelerFailed: count(true, false),
    judgeFailedLabelerPassed: count(false, true),
    judgeFailedLabelerFailed: count(false, false),
  };
}

function disagreementOf({ label, verdict }: MatchedLabel): EvalDisagreement {
  return {
    runId: verdict.runId,
    executionId: verdict.executionId,
    labeler: label.labeler,
    judgePassed: verdict.passed,
    failureTags: label.failureTags,
    ...(verdict.metrics === undefined ? {} : { metrics: verdict.metrics }),
    ...(label.score === undefined ? {} : { score: label.score }),
    ...(label.note === undefined ? {} : { note: label.note }),
  };
}

function agreementsOf(
  judge: string,
  pairs: readonly MatchedLabel[],
  labelers: readonly string[],
): EvalRaterAgreement[] {
  const withJudge = labelers.map((labeler) =>
    agreementOf(
      [judge, labeler],
      pairs
        .filter(({ label }) => label.labeler === labeler)
        .map(({ label, verdict }): RatedPair => [verdict.passed, label.passed]),
    ),
  );
  const between = labelers.flatMap((first, index) =>
    labelers.slice(index + 1).map((second) => labelersAgreementOf(pairs, first, second)),
  );
  return [...withJudge, ...between];
}

function judgeCalibrationOf(judge: string, pairs: readonly MatchedLabel[]): EvalJudgeCalibration {
  const labelers = [...new Set(pairs.map(({ label }) => label.labeler))];
  const scores = scoreCountsOf(pairs);
  const calibration: EvalJudgeCalibration = {
    judge,
    n: new Set(pairs.map(({ verdict }) => verdict.executionId)).size,
    labelers,
    agreements: agreementsOf(judge, pairs, labelers),
    confusion: labelers.map((labeler) => confusionOf(pairs, labeler)),
    disagreements: pairs
      .filter(({ label, verdict }) => label.passed !== verdict.passed)
      .map(disagreementOf),
    metrics: metricGroupsOf(pairs),
  };
  return scores === undefined ? calibration : { ...calibration, scores };
}

/** Each judge of `report` with labels in `labels`, in the artifact's order. */
export function calibrateJudges(
  report: EvalRunReport,
  labels: readonly EvalLabel[],
): EvalCalibrationResult {
  const match = matchLabels(report, labels);
  if (match.kind === "invalid") return match;
  const judges = match.judges.flatMap((judge) => {
    const pairs = match.matched.filter(({ verdict }) => verdict.judge === judge);
    return pairs.length === 0 ? [] : [judgeCalibrationOf(judge, pairs)];
  });
  const calibration: EvalCalibration = {
    suite: report.suite,
    labels: labels.length,
    matched: match.matched.length,
    unmatched: match.unmatched,
    judges,
  };
  return { kind: "calibrated", calibration };
}
