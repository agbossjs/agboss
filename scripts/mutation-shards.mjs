// What the mutation shards of packages/agboss/stryker.config.mjs are, as files (#1356, nightly root cause 2026-11-27):
// the files a shard mutates, the tests its vitest config runs, and which shards a change touches. Shared by
// check-mutation-reach.mjs (does a test of the shard reach each mutated file?) and mutation-changed.mjs (run only the
// shards a diff touches). No dependency: node's own glob.
import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, matchesGlob, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const ROOT = resolve(new URL("..", import.meta.url).pathname);
export const PACKAGE = join(ROOT, "packages/agboss");

/** The shards `stryker.config.mjs` defines, read from the tree at `root`: name -> { configFile, mutate, timeoutMs }. */
export async function readShards(root = ROOT) {
  const config = await import(pathToFileURL(join(root, "packages/agboss/stryker.config.mjs")).href);
  const { TIMEOUTS_MS } = await import(
    pathToFileURL(join(root, "scripts/stryker-timeouts-ms.mjs")).href
  );
  return Object.fromEntries(
    Object.entries(config.SHARDS).map(([name, shard]) => [
      name,
      {
        configFile: shard.configFile,
        mutate: [...shard.mutate],
        timeoutMs: TIMEOUTS_MS[name] ?? null,
      },
    ]),
  );
}

/** The `include` list of a vitest mutation config: its string literals, comments left out. */
export function includeOf(configFile, root = ROOT) {
  const text = readFileSync(join(root, "packages/agboss", configFile), "utf8");
  const body = /\binclude:\s*\[([\s\S]*?)\]/.exec(text)?.[1];
  if (body === undefined) throw new Error(`${configFile}: no \`include: [ … ]\` list`);
  const code = body.replace(/\/\/[^\n]*/g, "");
  return [...code.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

const globOf = (pattern) => pattern.replace(/:\d+-\d+$/, "");

const rangeOf = (pattern) => {
  const found = /:(\d+)-(\d+)$/.exec(pattern);
  return found === null ? null : [Number(found[1]), Number(found[2])];
};

/** Whether `file` is one a `mutate` list of Stryker (globs; `!` leaves a file out; `file:from-to` a part) names. */
export function mutates(patterns, file) {
  return (
    patterns.some((p) => !p.startsWith("!") && matchesGlob(file, globOf(p))) &&
    !patterns.some((p) => p.startsWith("!") && matchesGlob(file, p.slice(1)))
  );
}

/** The files a shard mutates: file (relative to packages/agboss) -> its line ranges, or null for the whole file. */
export function mutatedFilesOf(shard, cwd = PACKAGE) {
  const positive = shard.mutate.filter((p) => !p.startsWith("!"));
  const files = new Map();
  for (const pattern of positive) {
    const range = rangeOf(pattern);
    for (const file of globSync(globOf(pattern), { cwd })) {
      if (!file.endsWith(".ts") || !mutates(shard.mutate, file)) continue;
      const before = files.get(file);
      if (range === null || before === null) files.set(file, null);
      else files.set(file, [...(before ?? []), range]);
    }
  }
  return files;
}

/** The test files a shard's vitest config runs (relative to packages/agboss). */
export function testsOfShard(shard, cwd = PACKAGE, root = ROOT) {
  const include = includeOf(shard.configFile, root);
  return [...new Set(include.flatMap((pattern) => globSync(pattern, { cwd })))].sort();
}

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).trim();

/** The files a change touches, relative to the repo root: committed since `base`, uncommitted and untracked. */
export function changedFiles(base) {
  const since = git(["diff", "--name-only", base]).split("\n");
  const untracked = git(["ls-files", "--others", "--exclude-standard"]).split("\n");
  return [...new Set([...since, ...untracked])].filter((file) => file !== "");
}

/** Whether a changed file (relative to packages/agboss) touches a shard: its mutated src, its tests, its config. */
function touches(file, shard, tests) {
  if (file === shard.configFile) return true;
  if (file.startsWith("src/")) return mutates(shard.mutate, file);
  return file.startsWith("tests/") && tests.some((pattern) => matchesGlob(file, pattern));
}

/**
 * The shards a change touches: one that mutates a changed `src` file, runs a changed or new test, uses a changed
 * vitest mutation config, or is defined differently at `base` (its `mutate` list, config file or timeout in
 * stryker.config.mjs / stryker-ranges*.mjs / stryker-timeouts-ms.mjs). Everything else is untouched and is not run.
 */
export async function affectedShards(base, files = changedFiles(base)) {
  const shards = await readShards();
  const old = await shardsAt(base);
  const inPackage = files
    .filter((file) => file.startsWith("packages/agboss/"))
    .map((file) => relative("packages/agboss", file));
  return Object.entries(shards)
    .filter(([name, shard]) => {
      const before = old?.[name];
      if (before === undefined || JSON.stringify(before) !== JSON.stringify(shard)) return true;
      const tests = includeOf(shard.configFile);
      return (
        inPackage.some((file) => touches(file, shard, tests)) ||
        oldIncludeDiffers(base, shard.configFile)
      );
    })
    .map(([name]) => name);
}

/** The shards as they stand at `base`: the definition files of the base tree, and src (the ranges read it), are exported to a temp folder. */
async function shardsAt(base) {
  const dir = mkdtempSync(join(tmpdir(), "mutation-base-"));
  try {
    const archive = execFileSync(
      "git",
      ["archive", base, "scripts", "packages/agboss/stryker.config.mjs", "packages/agboss/src"],
      { cwd: ROOT, maxBuffer: 1 << 28 },
    );
    execFileSync("tar", ["-x", "-C", dir], { input: archive });
    return await readShards(dir);
  } catch {
    return undefined; // a base without the definition (an old base): every shard counts as changed
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Whether the include list of `configFile` at `base` is not the one now (an edit of the config file is also a diff). */
function oldIncludeDiffers(base, configFile) {
  try {
    const text = git(["show", `${base}:packages/agboss/${configFile}`]);
    const body = /\binclude:\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? "";
    const before = [...body.replace(/\/\/[^\n]*/g, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return JSON.stringify(before) !== JSON.stringify(includeOf(configFile));
  } catch {
    return true;
  }
}
