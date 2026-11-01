#!/usr/bin/env node
// The packed package in a project of its own (#497): what a user installs from npm, not the
// workspace link. Packs @agboss/core and @agboss/cli, creates a project outside the workspace with
// the packed CLI (`agboss create`, so its template is covered), installs the two tarballs, checks
// that @agboss/core is installed and not linked, then runs there:
//   - positive: the project's tests (`npm test`) plus a `workflowOf` test with no setup file loading
//     the application (AC1, AC5), `agboss describe` and `agboss check` (AC2);
//   - negative: the same test under a plain vitest config, without agbossTest() — it must fail with
//     workflowOf's TestSetupError (AC4: the error, and proof that this job catches a regression).
// `npm run check:packed` (builds first); CI's packed-project job. Not part of `make check`.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { USAGE, UsageError, parseArguments } from "./packed/args.mjs";
import { installedCoreProblem } from "./packed/installed.mjs";
import { NpmBeforeError, rangeInstallArguments } from "./packed/npm-before.mjs";
import { coreFramesOf, missingMapSources, missingSourceWarnings } from "./packed/source-maps.mjs";
import {
  CORE_FAILURE_TEST,
  CORE_FAILURE_TEST_FILE,
  OUTSIDE_GRAPH,
  PLAIN_VITEST_CONFIG,
  PROJECT,
  WORKFLOW_OF_TEST,
  WORKFLOW_OF_TEST_FILE,
} from "./packed/probe.mjs";

const REPO = new URL("..", import.meta.url).pathname;

class CheckFailed extends Error {}

/** Runs a command; its output is printed only when it fails (or when `expectFailure` is met). */
function run(step, command, args, cwd, { expectFailure = false } = {}) {
  console.log(`check:packed › ${step}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if ((result.status === 0) === expectFailure) {
    console.error(output);
    throw new CheckFailed(`${step}: ${expectFailure ? "passed, expected to fail" : "failed"}`);
  }
  return output;
}

function pack(work) {
  const packs = join(work, "packs");
  mkdirSync(packs, { recursive: true });
  run(
    "pack @agboss/core and @agboss/cli",
    "npm",
    ["pack", "-w", "@agboss/core", "-w", "@agboss/cli", "--pack-destination", packs],
    REPO,
  );
  const tarball = (prefix) => {
    const name = readdirSync(packs).find(
      (file) => file.startsWith(prefix) && file.endsWith(".tgz"),
    );
    if (name === undefined) throw new CheckFailed(`no ${prefix}*.tgz in ${packs}`);
    return join(packs, name);
  };
  return [tarball("agboss-core-"), tarball("agboss-cli-")];
}

/** `agboss create` by the packed CLI, installed on its own outside the workspace. */
function createProject(work, tarballs) {
  const tools = join(work, "tools");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, "package.json"), '{ "name": "packed-tools", "private": true }\n');
  run("install the packed CLI", "npm", tarballInstallArguments(tarballs), tools);
  run(
    `agboss create ${PROJECT}`,
    binOf(tools, "agboss"),
    ["create", PROJECT, "--yes", "--skip-install"],
    work,
  );
  return join(work, PROJECT);
}

/**
 * The tarballs by path; their dependencies' ranges resolved to releases at least three days old
 * (#523: `--before`, overridable with `AGBOSS_NPM_BEFORE`).
 */
export function tarballInstallArguments(tarballs, env = process.env, now = new Date()) {
  return rangeInstallArguments(["--no-audit", "--no-fund", ...tarballs], env, now);
}

/** A tool the project installed, run from its `node_modules/.bin` — never fetched from the registry. */
const binOf = (project, name) => join(project, "node_modules", ".bin", name);

function install(project, tarballs) {
  run("install the tarballs into the project", "npm", tarballInstallArguments(tarballs), project);
  run("npm ls @agboss/core", "npm", ["ls", "@agboss/core"], project);
  const problem = installedCoreProblem(project);
  if (problem !== undefined) throw new CheckFailed(problem);
  for (const name of ["core", "cli"]) {
    const missing = missingMapSources(join(project, "node_modules", "@agboss", name));
    if (missing.length > 0)
      throw new CheckFailed(
        `@agboss/${name}'s source maps name ${missing.length} sources it does not ship, e.g. ${missing[0]}`,
      );
  }
}

/** #645 AC1: no "points to missing source files" from vite in a test run of the project. */
function assertNoMissingSources(step, output) {
  const warnings = missingSourceWarnings(output);
  if (warnings.length > 0)
    throw new CheckFailed(`${step}: ${warnings.length} source-map warnings, e.g. ${warnings[0]}`);
}

/** #645 AC2: a test failing inside the core names files and lines the installed package has. */
function coreStackTrace(project) {
  mkdirSync(dirname(join(project, CORE_FAILURE_TEST_FILE)), { recursive: true });
  writeFileSync(join(project, CORE_FAILURE_TEST_FILE), CORE_FAILURE_TEST);
  const step = "positive: a failure inside the core names lines of the package";
  const output = run(step, binOf(project, "vitest"), ["run", CORE_FAILURE_TEST_FILE], project, {
    expectFailure: true,
  });
  rmSync(join(project, CORE_FAILURE_TEST_FILE));
  assertNoMissingSources(step, output);
  const frames = coreFramesOf(output, project);
  const broken = frames.filter((frame) => frame.problem !== undefined);
  if (frames.length === 0 || broken.length > 0)
    throw new CheckFailed(
      `${step}: ${frames.length === 0 ? "no frame inside the core" : `${broken[0].frame}: ${broken[0].problem}`}\n${output}`,
    );
}

function positive(project) {
  mkdirSync(dirname(join(project, WORKFLOW_OF_TEST_FILE)), { recursive: true });
  writeFileSync(join(project, WORKFLOW_OF_TEST_FILE), WORKFLOW_OF_TEST);
  const step = "positive: npm test (workflowOf, testWith, environments)";
  assertNoMissingSources(step, run(step, "npm", ["test"], project));
  coreStackTrace(project);
  run("positive: agboss describe", binOf(project, "agboss"), ["describe"], project);
  run("positive: agboss check", binOf(project, "agboss"), ["check"], project);
}

function negative(project) {
  writeFileSync(join(project, "vitest.config.ts"), PLAIN_VITEST_CONFIG);
  const output = run(
    "negative: workflowOf without agbossTest()",
    binOf(project, "vitest"),
    ["run", WORKFLOW_OF_TEST_FILE],
    project,
    { expectFailure: true },
  );
  if (!output.includes("TestSetupError") || !output.includes(OUTSIDE_GRAPH))
    throw new CheckFailed(
      `negative: the test failed, but not with workflowOf's TestSetupError:\n${output}`,
    );
}

function check(options) {
  const work =
    options.dir === undefined
      ? mkdtempSync(join(tmpdir(), "agboss-packed-"))
      : resolve(options.dir);
  mkdirSync(work, { recursive: true });
  const tarballs = pack(work);
  const project = createProject(work, tarballs);
  install(project, tarballs);
  positive(project);
  negative(project);
  if (options.keep) console.log(`check:packed › kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
  console.log("check:packed › the packed package works in a project of its own");
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) return void console.log(USAGE);
  if (options.verifyInstall === undefined) return check(options);
  const problem = installedCoreProblem(resolve(options.verifyInstall));
  if (problem !== undefined) throw new CheckFailed(problem);
  console.log(`${options.verifyInstall}: @agboss/core is installed, not linked`);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (!(
      error instanceof UsageError ||
      error instanceof CheckFailed ||
      error instanceof NpmBeforeError
    ))
      throw error;
    console.error(
      error instanceof UsageError
        ? `${error.message}\n\n${USAGE}`
        : `check:packed failed: ${error.message}`,
    );
    process.exit(error instanceof UsageError ? 2 : 1);
  }
}
