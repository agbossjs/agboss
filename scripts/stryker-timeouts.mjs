#!/usr/bin/env node
// A Timeout is a hang, and an error is not a pass (#1367). Stryker counts a Timeout as killed, and a mutant no test
// kills has to run every test that covers it: when that run is longer than Stryker's limit (`timeoutFactor` x the
// covering tests' net time + `timeoutMS`; the net time leaves out hooks and setup), the survivor reads as a Timeout and
// the score never shows it (agbossjs/mongodb#103: half of a shard's sampled Timeouts survived alone). `RuntimeError` and
// `CompileError` are left out of the score altogether: a shard whose mutants all errored still reads 100 %. The
// shards' config sets the limit above the whole run, so what is still a Timeout did not finish, and this check fails
// a report that holds a Timeout, a RuntimeError or a CompileError that nobody justified:
//   - an entry of `PROVEN_HANGS` (scripts/stryker-proven-hangs.json, a JSON array) names the mutant by its shard, file, mutator,
//     replacement, an anchor (a snippet of the mutated line, or of it and the next: a short one such as `try {` takes the line below) and a kind — `hit-limit` (Stryker counted the loop's
//     hits past its limit: no wait), `wall-clock` (the limit of time ended it: a loop Stryker cannot count; the
//     last resort, every one costs a whole limit in each cold run), `runtime-error` or `compile-error` — and a reason.
//     Never by the mutant's id, which a run numbers afresh, or its line, which an edit moves;
//   - both ways: a bad mutant that matches no entry fails, and an entry of the report's shard that matches no
//     mutant is stale and fails (`--partial` skips that half for a run of part of a shard).
// Self-contained: the list is a JSON file beside the script, `--hangs <file>` names another. The stores copy both as they are.
// `node scripts/stryker-timeouts.mjs [--partial] [--hangs <file>] <report.json> [...]` checks Stryker JSON reports
// (reporters: json); a report's shard is its file's name without `.json`.
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_HANGS = join(here, "stryker-proven-hangs.json");
const KINDS = ["hit-limit", "wall-clock", "runtime-error", "compile-error"];
const FIELDS = ["shard", "file", "mutator", "replacement", "anchor", "kind", "reason"];
const identityOf = (hang) =>
  JSON.stringify([hang.shard, hang.file, hang.mutator, hang.replacement, hang.anchor, hang.kind]);

/** The entries of a proven-hangs list that lack a field, name an unknown kind, or are there twice. */
export function problemsOfList(hangs) {
  if (!Array.isArray(hangs)) return ["PROVEN_HANGS is not an array"];
  const problems = [];
  const seen = new Set();
  hangs.forEach((hang, index) => {
    const at = `PROVEN_HANGS[${String(index)}]`;
    const missing =
      hang === null || typeof hang !== "object"
        ? FIELDS
        : FIELDS.filter((field) => typeof hang[field] !== "string" || hang[field].trim() === "");
    if (missing.length > 0) problems.push(`${at}: needs ${missing.join(", ")}`);
    else if (!KINDS.includes(hang.kind))
      problems.push(`${at}: kind "${hang.kind}" is none of ${KINDS.join(", ")}`);
    else if (seen.has(identityOf(hang)))
      problems.push(`${at}: ${hang.file} ${hang.anchor} is listed twice`);
    else seen.add(identityOf(hang));
  });
  return problems;
}

const isReport = (report) =>
  report !== null &&
  typeof report === "object" &&
  report.files !== null &&
  typeof report.files === "object";

/** What a mutant that is neither killed, survived nor ignored is, as an entry's `kind`; `undefined` for the others. */
function kindOf(mutant) {
  if (mutant.status === "Timeout")
    return String(mutant.statusReason ?? "").startsWith("Hit limit reached")
      ? "hit-limit"
      : "wall-clock";
  if (mutant.status === "RuntimeError") return "runtime-error";
  if (mutant.status === "CompileError") return "compile-error";
  return undefined;
}

/** The mutants of a report that are not killed or survived, with the text of the line each starts on. */
function badMutantsOf(report) {
  return Object.entries(report.files).flatMap(([file, { mutants, source }]) => {
    const lines = typeof source === "string" ? source.split("\n") : [];
    return mutants.flatMap((mutant) => {
      const kind = kindOf(mutant);
      if (kind === undefined) return [];
      const line = mutant.location.start.line;
      // the line and the next one: an anchor too short to be its own (`try {`) takes the line below
      const text = [lines[line - 1], lines[line]]
        .map((one) => (one ?? "").trim())
        .join(" ")
        .trim();
      return [{ file, mutant, kind, line, text }];
    });
  });
}

const matches = (hang, shard, found) =>
  hang.shard === shard &&
  hang.file === found.file &&
  hang.mutator === found.mutant.mutatorName &&
  hang.replacement === String(found.mutant.replacement) &&
  hang.kind === found.kind &&
  found.text.includes(hang.anchor);

const describeBad = (found) =>
  `${found.file}:${String(found.line)}: ${found.mutant.status} (${found.kind}) of a ${found.mutant.mutatorName} mutant -> ${String(found.mutant.replacement)}` +
  `${found.mutant.statusReason === undefined ? "" : ` [${String(found.mutant.statusReason)}]`}; line: ${found.text}`;

/** The problems of one report of `shard`: its unjustified mutants, and (unless `partial`) the entries of the shard that match none. */
function auditReport(name, shard, report, hangs, partial) {
  if (!isReport(report)) return [`${name}: not a Stryker JSON report (no "files")`];
  const bad = badMutantsOf(report);
  const problems = bad
    .filter((found) => !hangs.some((hang) => matches(hang, shard, found)))
    .map(
      (found) =>
        `${name}: ${describeBad(found)}. A survivor reads as a Timeout when its run outlasts the limit: run it alone with a limit of 3 x the shard's run; if it survives, kill it with a test; if it still does not finish, add it to PROVEN_HANGS (shard ${shard}) with the reason; an error is a mutant no test judged: find out why`,
    );
  if (!partial)
    for (const hang of hangs)
      if (hang.shard === shard && !bad.some((found) => matches(hang, shard, found)))
        problems.push(
          `${name}: PROVEN_HANGS has ${hang.file} ${hang.mutator} -> ${hang.replacement} (${hang.kind}, "${hang.anchor}") that matches no mutant of this report: stale, remove it`,
        );
  return problems;
}

/**
 * The violations of `reports` (parsed Stryker JSON, `{ name, shard, report }`) against `hangs`, as one line each; empty
 * when every Timeout, RuntimeError and CompileError is on the list and every entry of a reported shard still matches one.
 * @param {readonly { name: string, shard: string, report: any }[]} reports
 * @param {readonly { shard: string, file: string, mutator: string, replacement: string, anchor: string, kind: string, reason: string }[]} hangs
 * @param {{ partial?: boolean }} [options]
 * @returns {string[]}
 */
export function auditTimeouts(reports, hangs, options = {}) {
  const listed = problemsOfList(hangs);
  if (listed.length > 0) return listed;
  return reports.flatMap(({ name, shard, report }) =>
    auditReport(name, shard, report, hangs, options.partial === true),
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  let hangsFile = DEFAULT_HANGS;
  let partial = false;
  const paths = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--hangs") hangsFile = resolve(args[(index += 1)] ?? "");
    else if (args[index] === "--partial") partial = true;
    else paths.push(args[index]);
  }
  if (paths.length === 0) {
    console.error(
      "usage: node scripts/stryker-timeouts.mjs [--partial] [--hangs <file>] <report.json> [...]",
    );
    process.exit(2);
  }
  const PROVEN_HANGS = JSON.parse(readFileSync(hangsFile, "utf8"));
  const reports = paths.map((path) => ({
    name: path,
    shard: basename(path, ".json"),
    report: JSON.parse(readFileSync(path, "utf8")),
  }));
  const problems = auditTimeouts(reports, PROVEN_HANGS, { partial });
  if (problems.length > 0) {
    console.error(
      `Stryker Timeouts and errors (#1367) — a Timeout is a proven hang, an error is justified:\n  ${problems.join("\n  ")}`,
    );
    process.exit(1);
  }
  console.log(
    `Stryker Timeouts: no Timeout or error of ${paths.join(", ")} but the proven ones (${String(PROVEN_HANGS.length)} listed)`,
  );
}
