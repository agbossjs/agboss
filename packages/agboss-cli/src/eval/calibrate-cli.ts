import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EvalLabel } from "agboss/eval";
import { calibrateJudges, evalLabelsOf } from "agboss/internal";
import {
  requiredText,
  textOption,
  type CommandContext,
  type CommandOutcome,
} from "../cli/context.js";
import { CliError } from "../cli/errors.js";
import { calibrationLines } from "./calibration-lines.js";
import { readRunArtifact } from "./run-artifact.js";

/**
 * `agboss eval calibrate --report <run.json> [--labels <labels.jsonl>]` (#396 PR 4, S2 C4–C5, Q8):
 * each judge of a saved run against people's labels of its runs — `eval/labels/<suite>.jsonl` by
 * default. It loads no application and calls no model: κ, the confusion matrices, the
 * disagreements and the rubric come from the two files. Exit 2 for a run artifact or a labels file
 * it cannot read (`eval.run-not-found` / `eval.run-invalid`, `eval.labels-not-found` /
 * `eval.labels-invalid`).
 */

const labelsInvalid = (file: string, why: string): CliError =>
  new CliError("usage", "eval.labels-invalid", `${file} is not a labels file: ${why}`);

function labelsOf(context: CommandContext, file: string): readonly EvalLabel[] {
  let content: string;
  try {
    content = readFileSync(resolve(context.io.cwd, file), "utf8");
  } catch {
    throw new CliError("usage", "eval.labels-not-found", `no labels file at ${file}`);
  }
  const read = evalLabelsOf(content);
  if (read.kind === "invalid")
    throw labelsInvalid(file, `line ${String(read.line)}: ${read.reason}`);
  return read.labels;
}

export function evalCalibrateCommand(context: CommandContext): CommandOutcome {
  const reportFile = requiredText(context.values, "report");
  const report = readRunArtifact(context, reportFile);
  const labelsFile = textOption(context.values, "labels") ?? `eval/labels/${report.suite}.jsonl`;
  const calibrated = calibrateJudges(report, labelsOf(context, labelsFile));
  if (calibrated.kind === "invalid") throw labelsInvalid(labelsFile, calibrated.reason);
  const { calibration } = calibrated;
  for (const line of calibrationLines(calibration, labelsFile)) context.say(line);
  return { result: { reportFile, labelsFile, ...calibration } };
}
