#!/usr/bin/env node
// #811: the official A2A TCK (a2aproject/a2a-tck, pinned in tck-expected.json) against the AGBoss
// conformance agent (packages/agboss/tests/a2a-tck/), on JSON-RPC, twice: as published, then with
// tck-defects.patch (two TCK defects, each explained in tck-expected.json). Each run's requirements
// are checked against tck-expected.json: one that fails and is not listed, one listed that passes,
// and one that does not pass with no reason named fail the run. Python runs in a venv inside the TCK
// clone (`uv sync --frozen`, the TCK's own lock), never the system's.
//
//   node scripts/a2a-tck.mjs [--dir <work dir>] [--port <port>]
//
// The work dir (default `.a2a-tck/`, git-ignored) keeps the clone, its venv and each run's reports.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { problemsOf } from "./a2a-tck/check.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const framework = join(root, "packages/agboss");
const suite = join(framework, "tests/a2a-tck");
const expected = JSON.parse(readFileSync(join(suite, "tck-expected.json"), "utf8"));

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const work = resolve(argOf("--dir", join(root, ".a2a-tck")));
const port = Number(argOf("--port", "19811"));
const tck = join(work, "a2a-tck");

const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
const read = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: "utf8" }).trim();

/** The TCK at its pinned commit, its venv synced from its own lock. */
function checkedOutTck() {
  mkdirSync(work, { recursive: true });
  if (!existsSync(join(tck, ".git"))) {
    run("git", ["init", "-q", tck], work);
    run("git", ["remote", "add", "origin", expected.tck.repository], tck);
  }
  run("git", ["fetch", "-q", "--depth", "1", "origin", expected.tck.commit], tck);
  run("git", ["checkout", "-q", "--force", expected.tck.commit], tck);
  run("git", ["clean", "-q", "-fdx", "-e", ".venv"], tck);
  const head = read("git", ["rev-parse", "HEAD"], tck);
  if (head !== expected.tck.commit) throw new Error(`TCK at ${head}, not ${expected.tck.commit}`);
  run("uv", ["sync", "-q", "--frozen", "--python", expected.tck.python], tck);
}

/** How long the conformance agent may take to say it is ready. */
const READY_WITHIN = 120_000;

/**
 * The conformance agent on 127.0.0.1, once it says it is ready (else it fails, past
 * `READY_WITHIN` too); `died()` says why it ended since, `undefined` while it lives.
 */
function startedSut() {
  const child = spawn(
    join(root, "node_modules", ".bin", "tsx"),
    ["tests/a2a-tck/tck-serve.ts", String(port)],
    {
      cwd: framework,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  let death;
  return new Promise((ready, failed) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      failed(new Error(`the conformance agent was not ready within ${READY_WITHIN} ms: ${out}`));
    }, READY_WITHIN);
    const onData = (chunk) => {
      out += String(chunk);
      const url = /tck-sut ready (\S+)/.exec(out)?.[1];
      if (url === undefined) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.resume();
      ready({ url, stop: () => child.kill("SIGTERM"), died: () => death });
    };
    child.stdout.on("data", onData);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      death = `the conformance agent exited (code ${code}, signal ${signal})`;
      failed(new Error(`${death}: ${out}`));
    });
  });
}

/**
 * One TCK run; its reports kept under `<work>/<name>/`. pytest's exit 1 is "some tests failed" —
 * the check decides; any other failure (interrupted, an internal or usage error, nothing collected,
 * no Python) or no report is the run's own failure, never judged as a result.
 */
function tckRun(name, sut) {
  rmSync(join(tck, "reports"), { recursive: true, force: true });
  try {
    run(
      join(tck, ".venv/bin/python"),
      ["run_tck.py", "--sut-host", sut.url, "--transport", expected.transport],
      tck,
    );
  } catch (error) {
    if (error.status !== 1)
      throw new Error(
        `run_tck.py (${name}) did not complete: status ${error.status}, signal ${error.signal}`,
        { cause: error },
      );
  }
  if (sut.died() !== undefined) throw new Error(`${name}: ${sut.died()} during the run`);
  for (const file of ["compatibility.json", "junitreport.xml"])
    if (!existsSync(join(tck, "reports", file)))
      throw new Error(`run_tck.py (${name}) wrote no ${file}: it recorded no results`);
  const out = join(work, name);
  rmSync(out, { recursive: true, force: true });
  cpSync(join(tck, "reports"), out, { recursive: true });
  return JSON.parse(readFileSync(join(out, "compatibility.json"), "utf8"));
}

checkedOutTck();
const sut = await startedSut();
let problems = [];
const used = new Set();
let failure;
try {
  for (const name of ["official", "patched"]) {
    if (name === "patched") run("git", ["apply", join(suite, expected.runs.patched.patch)], tck);
    const report = tckRun(name, sut);
    problems = [...problems, ...problemsOf(expected, name, join(work, name), report, used)];
  }
} catch (error) {
  failure = error;
} finally {
  sut.stop();
  try {
    run("git", ["checkout", "-q", "--", "."], tck);
  } catch (error) {
    console.error(`could not restore the TCK checkout: ${error}`);
  }
}
if (failure !== undefined) throw failure;
for (const key of Object.keys(expected.notPassing))
  if (!used.has(key)) problems.push(`notPassing.${key} names nothing that did not pass in any run`);
if (problems.length > 0) {
  console.error(`\nA2A TCK: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nA2A TCK ${expected.tck.tag} (${expected.tck.commit.slice(0, 7)}): as expected`);
