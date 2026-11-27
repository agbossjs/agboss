#!/usr/bin/env node
// A shard's tests reach what the shard mutates (nightly root cause 2026-11-27, #1356). A mutant of a line no test
// of the shard runs is NoCoverage, and the shard is red at its first run — in the nightly, three nights after the
// merge. This runs each shard's own vitest config once under v8 coverage (a dry run: seconds to a few minutes, no
// mutant) and FAILS when a file the shard mutates — or a `file:from-to` range of it — is run by no test of the
// shard: not one function of it was called (a file without functions: not one statement).
//
// Why a dry run and not the import graph: every test imports the application, so the closure of a shard's tests holds
// every file of `src/` and flags nothing. Coverage is what Stryker's own perTest analysis starts from.
//
// Usage: node scripts/check-mutation-reach.mjs [--shard a,b | --all | --changed [--base <ref>]] [--workers n] [--json]
// Exit 0: every mutated file is reached; 1: a file is not (listed); 2: a shard's tests did not pass.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { affectedShards, mutatedFilesOf, PACKAGE, readShards, ROOT } from "./mutation-shards.mjs";

/**
 * The files of one shard that no test ran. `coverage` is vitest's coverage-final.json (istanbul shape, keys are
 * absolute paths); `files` the shard's mutated files with their ranges (null: whole file).
 * @returns {string[]} the file, with the range when one, that nothing ran
 */
export function unreached(coverage, files, cwd = PACKAGE) {
  const missed = [];
  for (const [file, ranges] of files) {
    const data = coverage[join(cwd, file)];
    const within = (loc) =>
      ranges === null || ranges.some(([from, to]) => loc.start.line <= to && loc.end.line >= from);
    const fns =
      data === undefined ? [] : Object.entries(data.fnMap).filter(([, fn]) => within(fn.loc));
    const stmts =
      data === undefined ? [] : Object.entries(data.statementMap).filter(([, s]) => within(s));
    const ran =
      fns.length > 0
        ? fns.some(([id]) => (data.f[id] ?? 0) > 0)
        : stmts.some(([id]) => (data.s[id] ?? 0) > 0);
    if (!ran)
      missed.push(
        ranges === null ? file : `${file}:${ranges.map(([a, b]) => `${a}-${b}`).join(",")}`,
      );
  }
  return missed;
}

/**
 * Per file of the shard, the statements of the mutated region that no test ran: `{ file, uncovered, total }`, the
 * files with at least one. Information, not a failure: a statement nothing runs is the precursor of a NoCoverage
 * mutant (`--strict` fails on it), but v8 and Stryker differ on what a statement is, and a `Stryker disable` is
 * justified where it stands.
 */
export function partial(coverage, files, cwd = PACKAGE) {
  const rows = [];
  for (const [file, ranges] of files) {
    const data = coverage[join(cwd, file)];
    if (data === undefined) continue;
    const ids = Object.entries(data.statementMap).filter(
      ([, loc]) =>
        ranges === null ||
        ranges.some(([from, to]) => loc.start.line <= to && loc.end.line >= from),
    );
    const uncovered = ids.filter(([id]) => (data.s[id] ?? 0) === 0).length;
    if (uncovered > 0) rows.push({ file, uncovered, total: ids.length });
  }
  return rows;
}

/** Runs the shard's tests under coverage of its mutated files. */
function dryRun(name, shard, files, workers) {
  const out = mkdtempSync(join(tmpdir(), `mutation-reach-${name}-`));
  try {
    const args = [
      "run",
      "--config",
      shard.configFile,
      `--maxWorkers=${workers}`,
      "--no-file-parallelism",
      "--reporter=dot",
      "--silent",
      "--coverage.enabled",
      "--coverage.provider=v8",
      "--coverage.reporter=json",
      `--coverage.reportsDirectory=${out}`,
      "--coverage.thresholds.autoUpdate=false",
      ...[...files.keys()].map((file) => `--coverage.include=${file}`),
    ];
    const started = Date.now();
    const run = spawnSync(join(ROOT, "node_modules/.bin/vitest"), args, {
      cwd: PACKAGE,
      encoding: "utf8",
      maxBuffer: 1 << 28,
    });
    const seconds = Math.round((Date.now() - started) / 1000);
    if (run.status !== 0) return { error: `${run.stdout}\n${run.stderr}`.slice(-3000), seconds };
    return {
      coverage: JSON.parse(readFileSync(join(out, "coverage-final.json"), "utf8")),
      seconds,
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** The shards to check: --shard a,b, --all, or --changed. */
async function shardNames(shards) {
  if (process.argv.includes("--all")) return Object.keys(shards);
  if (process.argv.includes("--changed")) return affectedShards(option("--base") ?? "origin/main");
  return (option("--shard") ?? "").split(",").filter((name) => name !== "");
}

/** Runs one shard's check, prints it, returns the exit status it earns (0, 1: a file not reached, 2: tests failed). */
function checkShard(name, shard, workers, report) {
  const files = mutatedFilesOf(shard);
  const run = dryRun(name, shard, files, workers);
  if (run.error !== undefined) {
    console.error(`::error::mutation shard ${name}: its tests did not pass\n${run.error}`);
    report[name] = { seconds: run.seconds, error: true };
    return 2;
  }
  const missed = unreached(run.coverage, files);
  const rows = partial(run.coverage, files);
  const strict = process.argv.includes("--strict") ? rows.map((row) => row.file) : [];
  report[name] = { seconds: run.seconds, files: files.size, unreached: missed, partial: rows };
  console.log(
    `${missed.length === 0 ? "ok  " : "FAIL"} ${name} (${files.size} files, ${run.seconds} s)`,
  );
  for (const file of missed)
    console.error(
      `::error::mutation shard ${name}: ${file} is mutated but no test of the shard runs it — add the tests to the include list of ${shard.configFile}, or the file to another shard`,
    );
  if (rows.length > 0)
    console.log(
      `     ${rows.length} file(s) with statements no test runs: ${rows.map((r) => `${r.file} ${r.uncovered}/${r.total}`).join(", ")}`,
    );
  for (const file of strict)
    console.error(
      `::error::mutation shard ${name}: ${file} has statements no test runs (--strict)`,
    );
  return missed.length > 0 || strict.length > 0 ? 1 : 0;
}

async function main() {
  const shards = await readShards();
  const names = await shardNames(shards);
  if (names.length === 0) {
    console.log("check-mutation-reach: no shard to check (--shard a,b | --all | --changed)");
    return 0;
  }
  const report = {};
  let status = 0;
  for (const name of names) {
    if (shards[name] === undefined) throw new Error(`no shard "${name}"`);
    status = Math.max(status, checkShard(name, shards[name], option("--workers") ?? "1", report));
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  return status;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(await main());
