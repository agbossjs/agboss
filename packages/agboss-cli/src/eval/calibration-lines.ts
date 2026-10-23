import type {
  EvalCalibration,
  EvalConfusionMatrix,
  EvalJudgeCalibration,
  EvalMetricGroup,
  EvalRaterAgreement,
} from "agboss/eval";

/**
 * What `agboss eval calibrate` prints (#396 PR 4): a header line, then per judge its κ line, a
 * confusion matrix per labeler, the disagreements counted and listed, the rubric — each metric key
 * of the judge over the disagreements and the agreements — and the labelers' scores when they gave
 * some.
 */

const decimals = (value: number): string => value.toFixed(2);

const raterName = (judge: string, rater: string): string => (rater === judge ? "judge" : rater);

function kappaText(judge: string, agreement: EvalRaterAgreement): string {
  const [first, second] = agreement.raters;
  const value = agreement.kappa === undefined ? "—" : decimals(agreement.kappa);
  return `κ(${raterName(judge, first)}, ${raterName(judge, second)})=${value}`;
}

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

function confusionLines(matrix: EvalConfusionMatrix): string[] {
  const rows = [
    [matrix.labeler, `${matrix.labeler} passed`, `${matrix.labeler} failed`],
    [
      "judge passed",
      String(matrix.judgePassedLabelerPassed),
      String(matrix.judgePassedLabelerFailed),
    ],
    [
      "judge failed",
      String(matrix.judgeFailedLabelerPassed),
      String(matrix.judgeFailedLabelerFailed),
    ],
  ];
  const widths = [0, 1, 2].map((column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  return rows.map((row) =>
    `  ${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ")}`.trimEnd(),
  );
}

function metricLine(group: EvalMetricGroup): string {
  const counts = `${plural(group.disagreements, "disagreement")}, ${plural(group.agreements, "agreement")}`;
  if (group.mean !== undefined) {
    const { disagreements, agreements } = group.mean;
    const on = (mean: number | undefined): string => (mean === undefined ? "—" : decimals(mean));
    return `  ${group.key}: ${counts} — mean ${on(disagreements)} on disagreements, ${on(agreements)} on agreements`;
  }
  const values = (group.values ?? [])
    .map((value) => `${value.value} ${String(value.disagreements)}/${String(value.agreements)}`)
    .join(", ");
  return `  ${group.key}: ${counts} — disagreed/agreed by value: ${values}`;
}

function disagreementLines(judge: EvalJudgeCalibration): string[] {
  const { disagreements } = judge;
  if (disagreements.length === 0) return ["  no disagreements"];
  const passedFailed = disagreements.filter((found) => found.judgePassed).length;
  const summary = `  ${plural(disagreements.length, "disagreement")}: judge passed / labeler failed ${String(passedFailed)}, judge failed / labeler passed ${String(disagreements.length - passedFailed)}`;
  const listed = disagreements.map((found) => {
    const verdicts = found.judgePassed
      ? "judge passed, labeler failed"
      : "judge failed, labeler passed";
    const tags = found.failureTags.length === 0 ? "" : ` [${found.failureTags.join(", ")}]`;
    const note = found.note === undefined ? "" : ` — ${found.note}`;
    return `    ${found.runId} ${found.labeler}: ${verdicts}${tags}${note}`;
  });
  return [summary, ...listed];
}

function scoreLine(judge: EvalJudgeCalibration): string[] {
  const { scores } = judge;
  if (scores === undefined) return [];
  const counts = (values: readonly number[]): string => values.map(String).join("·");
  return [
    `  scores 1–4: judge passed ${counts(scores.judgePassed)}, judge failed ${counts(scores.judgeFailed)}`,
  ];
}

function judgeLines(judge: EvalJudgeCalibration): string[] {
  const kappas = judge.agreements.map((agreement) => kappaText(judge.judge, agreement)).join("  ");
  return [
    `${judge.judge}  n=${String(judge.n)}  ${kappas}`,
    ...judge.confusion.flatMap(confusionLines),
    ...disagreementLines(judge),
    ...judge.metrics.map(metricLine),
    ...scoreLine(judge),
  ];
}

/** Every line, the header first. */
export function calibrationLines(calibration: EvalCalibration, labelsFile: string): string[] {
  const header = `${calibration.suite} against ${labelsFile}: ${plural(calibration.labels, "label")}, ${String(calibration.matched)} matched, ${String(calibration.unmatched)} of other runs or unjudged`;
  if (calibration.judges.length === 0)
    return [header, "no label matches a judge's verdict in this run"];
  return [header, ...calibration.judges.flatMap(judgeLines)];
}
