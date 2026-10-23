/**
 * #396 PR 3 — a run against its baseline: each case's `CaseComparison` (S2 Q6–Q7: a changed case
 * is not compared, a case that flapped on the baseline is quarantined, regressed = pass^k there and
 * not now), and the baseline artifact read back (its kind and schema version checked).
 */
import { describe, expect, it } from "vitest";
import {
  CaseComparison,
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  EvalCascade,
  type EvalCaseReport,
  type EvalRunReport,
} from "../../src/eval/index.js";
import { compareEvalRuns } from "../../src/eval/run/compare-runs.js";
import { evalRunReportOf } from "../../src/eval/run/read-report.js";
import { caseReportOf, summaryOf, type EvalRunResult } from "../../src/eval/run/report.js";

/** A run of a case: passed or not. */
const runOf = (run: number, passed: boolean): EvalRunResult => ({
  run,
  threadId: `thread-${String(run)}`,
  passed,
  checks: [],
  spentUsd: 0,
});

/** A case over its runs (`[true, false, true]`: ✓✗✓), with its hash. */
const caseOf = (
  name: string,
  runs: readonly boolean[],
  caseHash = `${name}-hash`,
): EvalCaseReport =>
  caseReportOf(
    name,
    caseHash,
    runs.map((passed, index) => runOf(index + 1, passed)),
  );

const Y = true;
const N = false;

const reportOf = (cases: readonly EvalCaseReport[]): EvalRunReport => ({
  kind: EVAL_RUN_KIND,
  schemaVersion: EVAL_RUN_SCHEMA_VERSION,
  suite: "refunds-eval-suite",
  application: { name: "desk-application", version: "1.0.0" },
  workflow: { name: "desk-workflow", version: "1.0.0" },
  configHash: "7c1e09",
  start: "chat-workflow-start",
  environment: "eval",
  runs: 3,
  cascade: EvalCascade.StopAtFirstFailure,
  startedAt: "2026-01-05T09:00:00.000Z",
  endedAt: "2026-01-05T09:01:00.000Z",
  cases,
  summary: summaryOf(cases),
  spend: { totalUsd: 0 },
});

const BASELINE = reportOf([
  caseOf("stable-then-broken", [Y, Y, Y]),
  caseOf("flaky-on-main", [Y, N, Y]),
  caseOf("stable", [Y, Y, Y]),
  caseOf("failing-then-fixed", [N, N, N]),
  caseOf("edited", [Y, Y, Y]),
  caseOf("dropped", [Y, Y, Y]),
]);

const CANDIDATE = reportOf([
  caseOf("stable-then-broken", [Y, N, N]),
  caseOf("flaky-on-main", [N, N, N]),
  caseOf("stable", [Y, Y, Y]),
  caseOf("failing-then-fixed", [N, Y, N]),
  caseOf("edited", [N, N, N], "edited-hash-2"),
  caseOf("added", [Y, Y, Y]),
]);

describe("#396 PR 3: each case against its baseline", () => {
  it("a verdict per case of either run, this run's first", () => {
    const comparison = compareEvalRuns(BASELINE, CANDIDATE, "main.json");

    expect(comparison.cases.map((found) => [found.name, found.comparison])).toEqual([
      ["stable-then-broken", CaseComparison.Regressed],
      ["flaky-on-main", CaseComparison.FlakyOnBaseline],
      ["stable", CaseComparison.Unchanged],
      ["failing-then-fixed", CaseComparison.Improved],
      ["edited", CaseComparison.Changed],
      ["added", CaseComparison.New],
      ["dropped", CaseComparison.Removed],
    ]);
  });

  it("only a case stable on the baseline regresses; the passes of both sides are kept", () => {
    const comparison = compareEvalRuns(BASELINE, CANDIDATE, "main.json");

    expect(comparison.regressed).toEqual(["stable-then-broken"]);
    expect(comparison.cases[0]).toEqual({
      name: "stable-then-broken",
      comparison: CaseComparison.Regressed,
      baseline: { passed: 3, runs: 3 },
      candidate: { passed: 1, runs: 3 },
    });
    expect(comparison).toMatchObject({
      file: "main.json",
      configHash: "7c1e09",
      runs: 3,
      startedAt: "2026-01-05T09:00:00.000Z",
    });
  });

  it("the closed set is an enum", () => {
    expect(Object.values(CaseComparison)).toEqual([
      "regressed",
      "improved",
      "unchanged",
      "flaky-on-baseline",
      "new",
      "removed",
      "changed",
    ]);
  });
});

describe("#396 PR 3: the baseline artifact read back", () => {
  it("a run artifact of this schema version reads as it was written", () => {
    const written: unknown = JSON.parse(JSON.stringify(BASELINE));

    expect(evalRunReportOf(written)).toEqual({ kind: "read", report: BASELINE });
  });

  it("another kind, another schema version or a missing field is refused, saying why", () => {
    expect(evalRunReportOf({ kind: "agboss.describe" })).toEqual({
      kind: "invalid",
      reason: 'kind is "agboss.describe", not "agboss.eval-run"',
    });
    expect(evalRunReportOf({ ...BASELINE, schemaVersion: 2 })).toEqual({
      kind: "invalid",
      reason: "schemaVersion 2 — this agboss reads 1",
    });
    expect(evalRunReportOf({ ...BASELINE, cases: [{ name: "x" }] })).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^cases\.0\.caseHash: /) as unknown,
    });
    expect(evalRunReportOf([])).toEqual({
      kind: "invalid",
      reason: 'kind is missing, not "agboss.eval-run"',
    });
  });

  it("the run's baseline comparison is part of the artifact, read back and checked (#397 S4)", () => {
    const report = { ...CANDIDATE, baseline: compareEvalRuns(BASELINE, CANDIDATE, "main.json") };
    const written: unknown = JSON.parse(JSON.stringify(report));

    expect(evalRunReportOf(written)).toEqual({ kind: "read", report });
    expect(
      evalRunReportOf({ ...report, baseline: { ...report.baseline, cases: [{ name: "x" }] } }),
    ).toMatchObject({
      kind: "invalid",
      reason: expect.stringMatching(/^baseline\.cases\.0\.comparison: /) as unknown,
    });
  });
});
