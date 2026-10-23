import { configSnapshot } from "../run/versions.js";
import type { AgentExecutionDeps } from "../index.js";
import type { PairwiseResult, ProfileOutcome } from "./compare.js";

/** One row of the comparison: a profile vs the baseline (the first profile). */
export interface ProfileReport {
  readonly name: string;
  readonly version: string;
  readonly meanScore: number | null;
  readonly scored: number;
  readonly pairwise: PairwiseResult | null;
  readonly costUsd: number;
  readonly costPerTaskUsd: number;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
  readonly failed: number;
  readonly diff: readonly string[];
  readonly stoppedBy?: string;
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? null;
}

/** Flattened `path → value`; prompts show only that they changed, not their text. */
function flatten(value: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, item] of Object.entries(value))
      flatten(item, path === "" ? key : `${path}.${key}`, out);
  } else if (value !== undefined) {
    out.set(path, JSON.stringify(value));
  }
  return out;
}

/** What differs between two runs' configs and prompts: `agents.scout.thinking: "none" → "low"`. */
export function configDiff(
  base: AgentExecutionDeps<string>,
  other: AgentExecutionDeps<string>,
): string[] {
  const a = flatten(configSnapshot(base));
  const b = flatten(configSnapshot(other));
  const keys = [...new Set([...a.keys(), ...b.keys()])]
    .filter((key) => key !== "config.version")
    .sort();
  return keys.flatMap((key) => {
    const before = a.get(key);
    const after = b.get(key);
    if (before === after) return [];
    if (key.startsWith("prompts.") || (key.startsWith("compactions.") && key.endsWith(".prompt")))
      return [`${key}: changed`];
    return [`${key.replace(/^config\./, "")}: ${before ?? "—"} → ${after ?? "—"}`];
  });
}

export function profileReport(
  outcome: ProfileOutcome,
  pair: PairwiseResult | null,
  diff: readonly string[],
): ProfileReport {
  const scored = outcome.scores.filter((s): s is number => s !== undefined);
  const done = outcome.answers.filter((a) => a !== undefined).length;
  return {
    name: outcome.name,
    version: outcome.version,
    meanScore: scored.length === 0 ? null : scored.reduce((sum, s) => sum + s, 0) / scored.length,
    scored: scored.length,
    pairwise: pair,
    costUsd: outcome.costUsd,
    costPerTaskUsd: done === 0 ? 0 : outcome.costUsd / done,
    latencyP50Ms: percentile(outcome.latenciesMs, 50),
    latencyP95Ms: percentile(outcome.latenciesMs, 95),
    failed: outcome.failed,
    diff,
    ...(outcome.stoppedBy === undefined ? {} : { stoppedBy: outcome.stoppedBy }),
  };
}

const num = (value: number | null, digits: number): string =>
  value === null ? "—" : value.toFixed(digits);

/** A readable table plus each profile's diff against the baseline. */
export function formatComparison(tasks: number, rows: readonly ProfileReport[]): string[] {
  const lines = [
    `${String(tasks)} tasks`,
    "profile | version | mean | vs base (w/l/t, flips) | cost | per task | p50 s | p95 s | failed",
  ];
  for (const r of rows) {
    const vs =
      r.pairwise === null
        ? "baseline"
        : `${String(r.pairwise.wins)}/${String(r.pairwise.losses)}/${String(r.pairwise.ties)}, flips ${String(r.pairwise.positionFlips)}`;
    const p50 = r.latencyP50Ms === null ? null : r.latencyP50Ms / 1000;
    const p95 = r.latencyP95Ms === null ? null : r.latencyP95Ms / 1000;
    lines.push(
      `${r.name} | ${r.version} | ${num(r.meanScore, 2)} | ${vs} | $${r.costUsd.toFixed(4)} | $${r.costPerTaskUsd.toFixed(4)} | ${num(p50, 1)} | ${num(p95, 1)} | ${String(r.failed)}${r.stoppedBy === undefined ? "" : ` (${r.stoppedBy})`}`,
    );
  }
  for (const r of rows.filter((row) => row.pairwise !== null)) {
    lines.push(
      "",
      `${r.name} vs baseline:`,
      ...(r.diff.length === 0 ? ["  (no config difference)"] : r.diff.map((d) => `  ${d}`)),
    );
  }
  return lines;
}
