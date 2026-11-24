/**
 * #396 PR 4 — `agboss eval calibrate`: a judge's verdicts in a run artifact against people's labels
 * (S2 C4–C5, Q8) — pairwise Cohen's κ between the judge and each labeler and between labelers, the
 * confusion matrix, the disagreements grouped by the judge's `metrics` keys, and the scores' view.
 */
import { describe, expect, it } from "vitest";
import {
  CheckStatus,
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  EvalCascade,
  type EvalCheckResult,
  type EvalLabel,
  type EvalRunReport,
  type EvalRunResult,
} from "../../src/eval/index.js";
import { calibrateJudges } from "../../src/eval/calibrate/calibrate.js";
import { cohenKappa, type RatedPair } from "../../src/eval/calibrate/kappa.js";
import { evalLabelsOf } from "../../src/eval/calibrate/labels.js";
import { caseReportOf, summaryOf } from "../../src/eval/run/report.js";

const JUDGE = "answer-grounded-judge";

const Y = true;
const N = false;

/** A run whose judge passed or failed it, with the judge's metrics. */
const runOf = (
  run: number,
  passed: boolean,
  metrics: EvalCheckResult["metrics"] = { long: false, length: 100 },
): EvalRunResult => ({
  run,
  threadId: `thread-${String(run)}`,
  executionId: `execution-${String(run)}`,
  passed,
  checks: [
    { check: "trajectory", status: CheckStatus.Passed },
    { check: JUDGE, status: passed ? CheckStatus.Passed : CheckStatus.Failed, metrics },
  ],
  spentUsd: 0,
});

const reportOf = (runResults: readonly EvalRunResult[]): EvalRunReport => {
  const cases = [caseReportOf("refund", "refund-hash", runResults)];
  return {
    kind: EVAL_RUN_KIND,
    schemaVersion: EVAL_RUN_SCHEMA_VERSION,
    suite: "refunds-eval-suite",
    application: { name: "desk-application", version: "1.0.0" },
    workflow: { name: "desk-workflow", version: "1.0.0" },
    configHash: "7c1e09",
    start: "chat-workflow-start",
    environment: "eval",
    runs: runResults.length,
    cascade: EvalCascade.RunAll,
    startedAt: "2026-01-05T09:00:00.000Z",
    endedAt: "2026-01-05T09:01:00.000Z",
    cases,
    summary: summaryOf(cases),
    spend: { totalUsd: 0 },
  };
};

const labelOf = (run: number, labeler: string, passed: boolean, extra = {}): EvalLabel => ({
  runId: `refund#${String(run)}`,
  executionId: `execution-${String(run)}`,
  judge: JUDGE,
  labeler,
  passed,
  failureTags: [],
  ...extra,
});

const calibrated = (report: EvalRunReport, labels: readonly EvalLabel[]) => {
  const result = calibrateJudges(report, labels);
  if (result.kind !== "calibrated") throw new Error(result.reason);
  return result.calibration;
};

describe("#396 PR 4: Cohen's κ", () => {
  it("agreement beyond chance: 8 of 10 with even pass rates is 0.6", () => {
    const first = [Y, Y, Y, Y, Y, N, N, N, N, N];
    const second = [Y, Y, Y, Y, N, N, N, N, N, Y];
    const pairs = first.map((verdict, index): RatedPair => [verdict, second[index] ?? N]);

    expect(cohenKappa(pairs)).toBeCloseTo(0.6, 10);
  });

  it("undefined without pairs, and when both raters gave one verdict only", () => {
    expect(cohenKappa([])).toBeUndefined();
    expect(
      cohenKappa([
        [Y, Y],
        [Y, Y],
      ]),
    ).toBeUndefined();
    expect(
      cohenKappa([
        [Y, N],
        [N, Y],
      ]),
    ).toBe(-1);
  });
});

describe("#396 PR 4: the labels file", () => {
  const line = (label: object): string => JSON.stringify(label);

  it("one label per line, blank lines skipped", () => {
    const content = `${line(labelOf(1, "anna", Y))}\n\n${line(labelOf(2, "anna", N, { score: 2, note: "invents a fee" }))}\n`;

    expect(evalLabelsOf(content)).toEqual({
      kind: "read",
      labels: [labelOf(1, "anna", Y), labelOf(2, "anna", N, { score: 2, note: "invents a fee" })],
    });
  });

  it("a line that is not a label refuses the file, naming the line and why", () => {
    const valid = line(labelOf(1, "anna", Y));

    expect(evalLabelsOf(`${valid}\n{`)).toEqual({ kind: "invalid", line: 2, reason: "not JSON" });
    expect(evalLabelsOf(line({ ...labelOf(1, "anna", Y), failureTags: undefined }))).toMatchObject({
      kind: "invalid",
      line: 1,
      reason: expect.stringMatching(/^failureTags: /) as unknown,
    });
    expect(evalLabelsOf(line(labelOf(1, "anna", Y, { score: 5 })))).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^score: /) as unknown,
    });
    expect(evalLabelsOf(`${valid}\n${valid}`)).toEqual({
      kind: "invalid",
      line: 2,
      reason: `a second label by anna of execution-1 for ${JUDGE} (the first on line 1)`,
    });
  });
});

describe("#396 PR 4: a judge against its labels", () => {
  const judged = [Y, Y, Y, Y, Y, N, N, N, N, N];
  const anna = [Y, Y, Y, Y, N, N, N, N, N, Y];
  const ben = [Y, Y, Y, Y, N, N, N, N, N, Y];
  const report = reportOf(judged.map((passed, index) => runOf(index + 1, passed)));
  const labels = [
    ...anna.map((passed, index) => labelOf(index + 1, "anna", passed)),
    ...ben.map((passed, index) => labelOf(index + 1, "ben", passed)),
  ];

  it("κ of the judge with each labeler, then of the labelers with each other", () => {
    const [judge] = calibrated(report, labels).judges;

    expect(judge?.n).toBe(10);
    expect(judge?.labelers).toEqual(["anna", "ben"]);
    expect(judge?.agreements.map(({ raters, n }) => [raters, n])).toEqual([
      [[JUDGE, "anna"], 10],
      [[JUDGE, "ben"], 10],
      [["anna", "ben"], 10],
    ]);
    expect(judge?.agreements[0]?.kappa).toBeCloseTo(0.6, 10);
    expect(judge?.agreements[2]).toMatchObject({ observed: 1, kappa: 1 });
  });

  it("a confusion matrix per labeler and every disagreement", () => {
    const [judge] = calibrated(report, labels).judges;

    expect(judge?.confusion[0]).toEqual({
      labeler: "anna",
      judgePassedLabelerPassed: 4,
      judgePassedLabelerFailed: 1,
      judgeFailedLabelerPassed: 1,
      judgeFailedLabelerFailed: 4,
    });
    expect(
      judge?.disagreements.map(({ runId, labeler, judgePassed }) => [runId, labeler, judgePassed]),
    ).toEqual([
      ["refund#5", "anna", true],
      ["refund#10", "anna", false],
      ["refund#5", "ben", true],
      ["refund#10", "ben", false],
    ]);
  });

  it("labels of other runs or of a judge that gave no verdict are counted, not matched", () => {
    const skipped = runOf(11, N);
    const withSkip = reportOf([
      runOf(1, Y),
      {
        ...skipped,
        checks: [{ check: JUDGE, status: CheckStatus.Skipped, skippedBy: "trajectory" }],
      },
    ]);
    const calibration = calibrated(withSkip, [
      labelOf(1, "anna", Y),
      labelOf(11, "anna", N),
      labelOf(99, "anna", N),
    ]);

    expect(calibration).toMatchObject({ labels: 3, matched: 1, unmatched: 2 });
    expect(calibration.judges[0]?.agreements[0]).toEqual({
      raters: [JUDGE, "anna"],
      n: 1,
      observed: 1,
    });
  });

  it("a label naming another run of its execution does not fit this run", () => {
    expect(calibrateJudges(report, [{ ...labelOf(1, "anna", Y), runId: "refund#2" }])).toEqual({
      kind: "invalid",
      reason: "the label by anna names run refund#2, but execution-1 is refund#1 in this run",
    });
  });

  it("the rubric: each metrics key over the disagreements and agreements, and the scores", () => {
    const metricReport = reportOf([
      runOf(1, Y, { long: true, length: 950 }),
      runOf(2, Y, { long: false, length: 300 }),
      runOf(3, N, { long: false, length: 500 }),
    ]);
    const [judge] = calibrated(metricReport, [
      labelOf(1, "anna", N, { score: 1, failureTags: ["invents-fee"] }),
      labelOf(2, "anna", Y, { score: 4 }),
      labelOf(3, "anna", N, { score: 2 }),
    ]).judges;

    expect(judge?.metrics).toEqual([
      {
        key: "long",
        disagreements: 1,
        agreements: 2,
        values: [
          { value: "true", disagreements: 1, agreements: 0 },
          { value: "false", disagreements: 0, agreements: 2 },
        ],
      },
      {
        key: "length",
        disagreements: 1,
        agreements: 2,
        mean: { disagreements: 950, agreements: 400 },
      },
    ]);
    expect(judge?.scores).toEqual({ judgePassed: [1, 0, 0, 1], judgeFailed: [0, 1, 0, 0] });
    expect(judge?.disagreements).toEqual([
      {
        runId: "refund#1",
        executionId: "execution-1",
        labeler: "anna",
        judgePassed: true,
        metrics: { long: true, length: 950 },
        score: 1,
        failureTags: ["invents-fee"],
      },
    ]);
  });

  it("no score in any label: no scores view", () => {
    expect(calibrated(report, labels).judges[0]?.scores).toBeUndefined();
  });
});
