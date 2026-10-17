#!/usr/bin/env node
// Suppression ratchet (#180). Counts every escape hatch in the code and compares it with the
// committed budget in `.suppressions.json`. The budget may only go down:
//   - any count above budget            → fail (fix the code instead of suppressing it)
//   - a file-scope `/* eslint-disable */` → fail (always; suppress a line, with a reason)
//   - a new eslint-disable without `-- reason` beyond the budget → covered by the per-rule count
//   - any count below budget             → fail with a hint to lower the budget (keeps it honest)
// `node scripts/check-suppressions.mjs --write` rewrites the budget to the current counts.
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BUDGET_FILE = join(ROOT, ".suppressions.json");
const DIRS = [
  "packages/agboss/src",
  "packages/agboss/tests",
  "packages/agboss-cli/src",
  "packages/agboss-cli/tests",
  "examples/job-scout/src",
  "examples/job-scout/tests",
  "examples/flow-patterns/src",
  "examples/flow-patterns/tests",
];
const SKIP = new Set(["node_modules", "dist", "coverage"]);

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) yield path;
  }
}

const counts = {};
const fileScope = [];
const add = (key) => (counts[key] = (counts[key] ?? 0) + 1);

for (const dir of DIRS) {
  for (const path of files(join(ROOT, dir))) {
    const rel = relative(ROOT, path);
    const area = rel.includes("/tests/") ? "tests" : "src";
    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, i) => {
        const block = /\/\*\s*eslint-disable(?!-)/.exec(line);
        if (block) fileScope.push(`${rel}:${i + 1}`);
        const next = /eslint-disable-(?:next-)?line\s+([^*\n]*?)(?:\s+--.*)?(?:\*\/)?\s*$/.exec(
          line,
        );
        if (next) {
          const rules = next[1]
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean);
          for (const rule of rules.length ? rules : ["<all rules>"]) add(`${area} eslint:${rule}`);
        }
        if (/@ts-(ignore|nocheck)/.test(line)) add(`${area} @ts-ignore`);
        if (/\bas any\b/.test(line)) add(`${area} as any`);
        if (/\bas unknown as\b/.test(line)) add(`${area} as unknown as`);
      });
  }
}

const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
if (process.argv.includes("--write")) {
  writeFileSync(BUDGET_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`budget written: ${Object.values(sorted).reduce((a, b) => a + b, 0)} suppressions`);
  process.exit(0);
}

const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
const problems = [];
for (const at of fileScope)
  problems.push(
    `file-scope eslint-disable at ${at} — disable a single line with "-- reason" instead`,
  );
for (const key of new Set([...Object.keys(budget), ...Object.keys(sorted)])) {
  const now = sorted[key] ?? 0;
  const allowed = budget[key] ?? 0;
  if (now > allowed)
    problems.push(`${key}: ${now} > budget ${allowed} — fix the code instead of suppressing it`);
  else if (now < allowed)
    problems.push(
      `${key}: ${now} < budget ${allowed} — good; lower the budget: node scripts/check-suppressions.mjs --write`,
    );
}
if (problems.length) {
  console.error(`Suppression budget (.suppressions.json):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`suppressions within budget (${Object.values(sorted).reduce((a, b) => a + b, 0)})`);
