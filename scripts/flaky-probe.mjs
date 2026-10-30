#!/usr/bin/env node
// Probes a suspected flaky test (#509): runs one test file `runs` times, each one cold — a vitest
// process of its own with `--no-cache` — in the folder of the nearest vitest config above the file,
// then prints every run's outcome and real time and a summary line (`flaky-probe: 50/50 passed …`).
// Exit 0 when every run passed, 1 when one failed (its output printed), 2 on a usage error.
// QUALITY.md → Tests: how to probe a suspected flake.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

export const USAGE = "usage: node scripts/flaky-probe.mjs <test file> <runs>";

const CONFIGS = ["vitest.config.ts", "vitest.config.mjs", "vitest.config.js"];

export class UsageError extends Error {}

/** `<test file> <runs>` → `{ file, runs }`; `--help` → `{ help: true }`. */
export function parseArguments(args) {
  if (args.includes("--help")) return { help: true };
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown !== undefined) throw new UsageError(`unknown argument: ${unknown}`);
  const [file, count, ...rest] = args;
  if (file === undefined || count === undefined || rest.length > 0) throw new UsageError(USAGE);
  const runs = Number(count);
  if (!Number.isInteger(runs) || runs < 1) {
    throw new UsageError(`runs must be a whole number ≥ 1, got ${count}`);
  }
  return { file: resolve(file), runs };
}

/** The folder of the nearest vitest config above `file` — where vitest runs it. */
export function projectOf(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (CONFIGS.some((name) => existsSync(join(dir, name)))) return dir;
    if (dirname(dir) === dir) throw new UsageError(`no vitest config above ${file}`);
  }
}

/** The summary of the runs: how many passed, the median and the slowest real time. */
export function summaryOf(results) {
  const passed = results.filter((result) => result.passed).length;
  const times = results.map((result) => result.seconds).sort((first, second) => first - second);
  const median = times[Math.floor((times.length - 1) / 2)] ?? 0;
  const slowest = times.at(-1) ?? 0;
  return {
    passed,
    runs: results.length,
    line:
      `flaky-probe: ${String(passed)}/${String(results.length)} passed ` +
      `(median ${median.toFixed(2)} s, slowest ${slowest.toFixed(2)} s)`,
  };
}

/** One cold run: a fresh vitest process, no transform cache. */
function runOnce(vitest, project, file) {
  const startedAt = performance.now();
  const result = spawnSync(
    process.execPath,
    [vitest, "run", relative(project, file), "--no-cache"],
    {
      cwd: project,
      encoding: "utf8",
    },
  );
  return {
    passed: result.status === 0,
    seconds: (performance.now() - startedAt) / 1000,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function probe({ file, runs }) {
  if (!existsSync(file)) throw new UsageError(`no such test file: ${file}`);
  const project = projectOf(file);
  // the repository's own vitest, whatever folder the file is in
  const vitest = join(
    dirname(createRequire(import.meta.url).resolve("vitest/package.json")),
    "vitest.mjs",
  );
  const results = [];
  for (let run = 1; run <= runs; run++) {
    const result = runOnce(vitest, project, file);
    results.push(result);
    console.log(
      `run ${String(run)}: ${result.passed ? "passed" : "FAILED"} in ${result.seconds.toFixed(2)} s`,
    );
    if (!result.passed) console.log(result.output);
  }
  const summary = summaryOf(results);
  console.log(summary.line);
  return summary.passed === summary.runs ? 0 : 1;
}

function main(args) {
  try {
    const parsed = parseArguments(args);
    if (parsed.help === true) {
      console.log(USAGE);
      return 0;
    }
    return probe(parsed);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    return 2;
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  process.exitCode = main(process.argv.slice(2));
}
