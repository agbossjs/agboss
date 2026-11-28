#!/usr/bin/env node
// A mutation report (Stryker's JSON, packages/agboss/reports/mutation/<shard>.json) as text an agent can read:
// the score, the counts by status and the Survived / NoCoverage mutants as `file:line mutator -> replacement`.
//
//   node scripts/mutation-summary.mjs [--shard <name>] [--summary] <report.json | folder of reports>...
//   node scripts/mutation-summary.mjs --table [--summary] <folder>     one row per shard, then the lists
// Printed to the log; with --summary also appended to $GITHUB_STEP_SUMMARY (a job summary, 1 MiB at most: the lists are
// cut at LIMIT mutants per shard). Always exits 0: the shard's own step decides red or green.
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import process from "node:process";

const LIMIT = 300;
const LISTED = new Set(["Survived", "NoCoverage"]);
const COUNTED = [
  "Killed",
  "Survived",
  "NoCoverage",
  "Timeout",
  "RuntimeError",
  "CompileError",
  "Ignored",
];

/** The report files under `path`: the file, or every `*.json` in the folder and its sub-folders. */
function reportsIn(path) {
  if (!existsSync(path)) return [];
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return reportsIn(full);
    return entry.name.endsWith(".json") && !entry.name.startsWith("cli-") ? [full] : [];
  });
}

/** The counts, the score and the listed mutants of one report. */
export function read(report) {
  const counts = Object.fromEntries(COUNTED.map((status) => [status, 0]));
  const listed = [];
  for (const [file, data] of Object.entries(report.files ?? {})) {
    for (const mutant of data.mutants ?? []) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
      if (!LISTED.has(mutant.status)) continue;
      const replacement = String(mutant.replacement ?? "")
        .replace(/\s+/g, " ")
        .slice(0, 80);
      listed.push(
        `${file}:${mutant.location.start.line} ${mutant.status} ${mutant.mutatorName} -> ${replacement}`,
      );
    }
  }
  const detected = counts.Killed + counts.Timeout;
  const total = detected + counts.Survived + counts.NoCoverage;
  const score = total === 0 ? 100 : Math.round((detected / total) * 10000) / 100;
  return { counts, score, listed };
}

function section(name, result) {
  const { counts, score, listed } = result;
  const head = `### mutation shard ${name}: ${score} % (Killed ${counts.Killed}, Survived ${counts.Survived}, NoCoverage ${counts.NoCoverage}, Timeout ${counts.Timeout})`;
  const cut =
    listed.length > LIMIT ? [`... ${listed.length - LIMIT} more (see the report artifact)`] : [];
  return [head, ...listed.slice(0, LIMIT), ...cut].join("\n");
}

function table(rows) {
  const lines = [
    "| shard | score | killed | survived | no coverage | timeout |",
    "|---|---|---|---|---|---|",
  ];
  for (const [name, r] of rows)
    lines.push(
      `| ${name} | ${r.score} % | ${r.counts.Killed} | ${r.counts.Survived} | ${r.counts.NoCoverage} | ${r.counts.Timeout} |`,
    );
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--shard");
  const named = at === -1 ? undefined : args[at + 1];
  const paths = args.filter((arg, i) => !arg.startsWith("--") && i !== at + 1);
  const rows = paths
    .flatMap(reportsIn)
    .map((file) => [
      named ?? basename(file, ".json"),
      read(JSON.parse(readFileSync(file, "utf8"))),
    ]);
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const out =
    rows.length === 0
      ? `mutation-summary: no report found (${paths.join(", ")}): the shard's run did not get as far as writing one`
      : [args.includes("--table") ? table(rows) : "", ...rows.map(([name, r]) => section(name, r))]
          .filter((part) => part !== "")
          .join("\n\n");
  console.log(out);
  if (args.includes("--summary") && process.env.GITHUB_STEP_SUMMARY !== undefined)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${out}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
