/**
 * #396 PR 4 — `agboss eval calibrate --report <run.json> [--labels <labels.jsonl>]`: a saved run's
 * judges against people's labels — Cohen's κ, the confusion matrices, the disagreements and the
 * rubric printed, the calibration under `--json`, nothing loaded or run.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CheckStatus, type EvalLabel, type EvalRunResult } from "@agboss/core/eval";
import { artifactOf, caseOf } from "../eval-html/artifacts.js";
import { agboss, envelope } from "./agboss.js";

const CWD = mkdtempSync(join(tmpdir(), "agboss-eval-calibrate-"));
const JUDGE = "polite-refund-judge";

const runOf = (run: number, passed: boolean, length: number): EvalRunResult => ({
  run,
  threadId: `thread-${String(run)}`,
  executionId: `execution-${String(run)}`,
  passed,
  checks: [
    { check: "trajectory", status: CheckStatus.Passed },
    {
      check: JUDGE,
      status: passed ? CheckStatus.Passed : CheckStatus.Failed,
      metrics: { length },
    },
  ],
  spentUsd: 0,
});

const REPORT = join(CWD, "main.json");
writeFileSync(
  REPORT,
  JSON.stringify(
    artifactOf(
      [
        caseOf("refund", [
          runOf(1, true, 950),
          runOf(2, true, 300),
          runOf(3, false, 500),
          runOf(4, false, 400),
        ]),
      ],
      4,
    ),
  ),
);

const labelOf = (run: number, labeler: string, passed: boolean, extra = {}): EvalLabel => ({
  runId: `refund#${String(run)}`,
  executionId: `execution-${String(run)}`,
  judge: JUDGE,
  labeler,
  passed,
  failureTags: [],
  ...extra,
});

const LABELS = [
  labelOf(1, "anna", false, { failureTags: ["invents-fee"], note: "invents a fee" }),
  labelOf(2, "anna", true),
  labelOf(3, "anna", false),
  labelOf(4, "anna", false),
  labelOf(1, "ben", false),
  labelOf(2, "ben", true),
  labelOf(3, "ben", false),
  labelOf(4, "ben", true),
];

const writeLabels = (file: string, labels: readonly object[]): void => {
  writeFileSync(file, labels.map((label) => JSON.stringify(label)).join("\n"));
};

mkdirSync(join(CWD, "eval", "labels"), { recursive: true });
writeLabels(join(CWD, "eval", "labels", "refunds-eval-suite.jsonl"), LABELS);

describe("#396 PR 4: agboss eval calibrate", () => {
  it("prints κ, the confusion per labeler, the disagreements and the rubric — labels by default from eval/labels/<suite>.jsonl", async () => {
    const call = await agboss(["eval", "calibrate", "--report", REPORT], CWD);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain(
      "refunds-eval-suite against eval/labels/refunds-eval-suite.jsonl: 8 labels, 8 matched, 0 of other runs or unjudged",
    );
    expect(call.stdout).toContain(
      `${JUDGE}  n=4  κ(judge, anna)=0.50  κ(judge, ben)=0.00  κ(anna, ben)=0.50`,
    );
    expect(call.stdout).toContain("  judge passed  1            1");
    expect(call.stdout).toContain(
      "  3 disagreements: judge passed / labeler failed 2, judge failed / labeler passed 1",
    );
    expect(call.stdout).toContain(
      "    refund#1 anna: judge passed, labeler failed [invents-fee] — invents a fee",
    );
    expect(call.stdout).toContain(
      "  length: 3 disagreements, 5 agreements — mean 766.67 on disagreements, 400.00 on agreements",
    );
  });

  it("--json carries the calibration", async () => {
    const call = await agboss(["eval", "calibrate", "--report", REPORT, "--json"], CWD);

    expect(envelope(call)).toMatchObject({
      ok: true,
      result: {
        reportFile: REPORT,
        labelsFile: "eval/labels/refunds-eval-suite.jsonl",
        suite: "refunds-eval-suite",
        matched: 8,
        judges: [{ judge: JUDGE, n: 4, labelers: ["anna", "ben"] }],
      },
    });
  });

  it("a labels file that is not one: exit 2, eval.labels-invalid naming the line", async () => {
    const file = join(CWD, "bad.jsonl");
    writeLabels(file, [LABELS[0] ?? {}, { ...LABELS[1], passed: "yes" }]);
    const call = await agboss(
      ["eval", "calibrate", "--report", REPORT, "--labels", file, "--json"],
      CWD,
    );

    expect(call.code).toBe(2);
    expect(envelope(call)).toMatchObject({
      error: {
        code: "eval.labels-invalid",
        message: expect.stringContaining(
          `${file} is not a labels file: line 2: passed: `,
        ) as unknown,
      },
    });
  });

  it("no labels file: exit 2, eval.labels-not-found; --report is required", async () => {
    const missing = await agboss(
      ["eval", "calibrate", "--report", REPORT, "--labels", "none.jsonl", "--json"],
      CWD,
    );
    const noReport = await agboss(["eval", "calibrate", "--json"], CWD);

    expect(missing.code).toBe(2);
    expect(envelope(missing)).toMatchObject({
      error: { code: "eval.labels-not-found", message: "no labels file at none.jsonl" },
    });
    expect(noReport.code).toBe(2);
  });

  it("labels of other runs only: nothing to calibrate, exit 0", async () => {
    const file = join(CWD, "other.jsonl");
    writeLabels(file, [{ ...labelOf(1, "anna", true), executionId: "execution-99", runId: "x#1" }]);
    const call = await agboss(["eval", "calibrate", "--report", REPORT, "--labels", file], CWD);

    expect(call.code).toBe(0);
    expect(call.stdout).toContain("no label matches a judge's verdict in this run");
  });
});
