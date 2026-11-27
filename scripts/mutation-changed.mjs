#!/usr/bin/env node
// The mutation shards a change touches, and a run of only those (nightly root cause 2026-11-27, #1356): a shard
// whose mutated `src` file, test, vitest mutation config or definition changed since the base. Never all 45.
//
//   node scripts/mutation-changed.mjs                  list the touched shards (base: the merge base with origin/main)
//   node scripts/mutation-changed.mjs --base <ref>     another base
//   node scripts/mutation-changed.mjs --all            every shard (a manual dispatch)
//   node scripts/mutation-changed.mjs --github-output  `shards=<json>` and `any=<bool>` for a workflow's matrix
//   node scripts/mutation-changed.mjs --run [--workers n]   per shard: the reach check (check-mutation-reach.mjs),
//                                                      then its incremental Stryker run (`npm run test:mutation`)
// `npm run test:mutation:changed` is `--run`. Changes to shared test helpers (tests/helpers, src/testing) are
// not followed: run the shard by hand (`MUTATION_SHARD=<shard> npm run test:mutation -w @agboss/core`).
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { affectedShards, readShards, ROOT } from "./mutation-shards.mjs";

const option = (name) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

function baseRef() {
  const given = option("--base");
  if (given !== undefined) return given;
  return execFileSync("git", ["merge-base", "HEAD", "origin/main"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
}

const names = process.argv.includes("--all")
  ? Object.keys(await readShards())
  : await affectedShards(baseRef());

if (process.argv.includes("--github-output")) {
  const out = `shards=${JSON.stringify(names)}\nany=${names.length > 0}\n`;
  if (process.env.GITHUB_OUTPUT === undefined) process.stdout.write(out);
  else appendFileSync(process.env.GITHUB_OUTPUT, out);
} else console.log(names.length === 0 ? "no mutation shard is touched" : names.join("\n"));

if (process.argv.includes("--run")) {
  let status = 0;
  for (const shard of names) {
    console.log(`\n== mutation shard ${shard}`);
    const reach = spawnSync(
      "node",
      [
        "scripts/check-mutation-reach.mjs",
        "--shard",
        shard,
        "--workers",
        option("--workers") ?? "1",
      ],
      { cwd: ROOT, stdio: "inherit" },
    );
    if (reach.status !== 0) {
      status = 1;
      continue; // a file no test reaches is NoCoverage at the run's end: do not spend the run
    }
    const run = spawnSync("npm", ["run", "test:mutation", "-w", "@agboss/core"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, MUTATION_SHARD: shard },
    });
    if (run.status !== 0) status = 1;
  }
  process.exit(status);
}
