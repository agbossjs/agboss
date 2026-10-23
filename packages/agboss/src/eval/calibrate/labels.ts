import { z } from "zod";
import type { EvalLabel } from "./calibration.js";

/**
 * The labels file of `agboss eval calibrate` (#396 PR 4, S2 C4): JSON lines,
 * `eval/labels/<suite>.jsonl` by default — one person's verdict on one judged run per line. Blank
 * lines are skipped; a line that is not a label, or a second label of one run by one labeler for one
 * judge, refuses the whole file, naming its line.
 */

/** What reading a labels file gave: its labels, or the first line that is not one, and why. */
export type EvalLabelsRead =
  | { readonly kind: "read"; readonly labels: readonly EvalLabel[] }
  | { readonly kind: "invalid"; readonly line: number; readonly reason: string };

const text = z.string().min(1);

const LabelSchema: z.ZodType<EvalLabel> = z.looseObject({
  runId: text,
  executionId: text,
  judge: text,
  labeler: text,
  passed: z.boolean(),
  score: z.number().int().min(1).max(4).optional(),
  failureTags: z.array(z.string()),
  note: z.string().optional(),
});

type LineRead = { readonly label: EvalLabel } | { readonly reason: string };

function lineOf(line: string): LineRead {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { reason: "not JSON" };
  }
  const parsed = LabelSchema.safeParse(value);
  if (parsed.success) return { label: parsed.data };
  const [issue] = parsed.error.issues;
  if (issue === undefined) return { reason: "not a label" };
  const field = issue.path.join(".");
  return { reason: field === "" ? issue.message : `${field}: ${issue.message}` };
}

const keyOf = (label: EvalLabel): string =>
  JSON.stringify([label.executionId, label.judge, label.labeler]);

/** The labels in `content`, or the first line that is not one. */
export function evalLabelsOf(content: string): EvalLabelsRead {
  const labels: EvalLabel[] = [];
  const seenAt = new Map<string, number>();
  const lines = content.split("\n");
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (raw.trim() === "") continue;
    const read = lineOf(raw);
    if ("reason" in read) return { kind: "invalid", line, reason: read.reason };
    const { label } = read;
    const first = seenAt.get(keyOf(label));
    if (first !== undefined) {
      const reason = `a second label by ${label.labeler} of ${label.executionId} for ${label.judge} (the first on line ${String(first)})`;
      return { kind: "invalid", line, reason };
    }
    seenAt.set(keyOf(label), line);
    labels.push(label);
  }
  return { kind: "read", labels };
}

/**
 * `content` with `label` in it (#397 PR 4: a label saved from `agboss eval ui`): the label of the
 * same run, judge and labeler replaced in place, else appended — one JSON line each, so the file
 * stays what `evalLabelsOf` reads. `content` must read (a file that does not is never rewritten).
 */
export function labelsWith(content: string, label: EvalLabel): string {
  const read = evalLabelsOf(content);
  if (read.kind === "invalid") throw new Error(`line ${String(read.line)}: ${read.reason}`);
  const key = keyOf(label);
  const isSame = (each: EvalLabel): boolean => keyOf(each) === key;
  const labels = read.labels.some(isSame)
    ? read.labels.map((each) => (isSame(each) ? label : each))
    : [...read.labels, label];
  return labels.map((each) => `${JSON.stringify(each)}\n`).join("");
}

/** One label read from a form or a request: the label, or why it is not one. */
export type EvalLabelRead =
  | { readonly kind: "read"; readonly label: EvalLabel }
  | { readonly kind: "invalid"; readonly reason: string };

/** A label from a form or a request, validated as a line of the file is. */
export function evalLabelOf(value: unknown): EvalLabelRead {
  const parsed = LabelSchema.safeParse(value);
  if (parsed.success) return { kind: "read", label: parsed.data };
  const [issue] = parsed.error.issues;
  const reason = issue === undefined ? "not a label" : `${issue.path.join(".")}: ${issue.message}`;
  return { kind: "invalid", reason };
}
