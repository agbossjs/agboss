/**
 * #1356 (the twin of agbossjs/mongodb#94, postgres#129, redis#50): every file of `src/` is mutated by a
 * shard of `stryker.config.mjs`, or is named in `NON_SHARDED_SRC` with the reason it is not — so a module
 * added to a money path is a conscious decision of a shard, never a file no mutant reaches.
 */
import { readdirSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../helpers/process.js";
import { NON_SHARDED_SRC, PARTLY_SHARDED_SRC } from "./non-sharded-src.js";

const pkg = new URL("../../", import.meta.url).pathname;

/** The `mutate` lists of every shard, as `stryker.config.mjs` (and `stryker-ranges.mjs`) build them. */
async function mutateOfShards(): Promise<Record<string, readonly string[]>> {
  const run = await runProcess(
    "node",
    [
      "--input-type=module",
      "-e",
      "const { SHARDS } = await import(process.argv[1]);" +
        "console.log(JSON.stringify(Object.fromEntries(Object.entries(SHARDS).map(([name, shard]) => [name, shard.mutate]))));",
      join(pkg, "stryker.config.mjs"),
    ],
    { cwd: pkg },
  );
  if (run.status !== 0) throw new Error(`stryker.config.mjs: ${run.stderr}`);
  return JSON.parse(run.stdout) as Record<string, readonly string[]>;
}

/** The shards are read once: the read starts a process. */
const shardPatterns = mutateOfShards().then((shards) => Object.values(shards).flat());

const sourcesOf = (dir: string): string[] =>
  readdirSync(join(pkg, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourcesOf(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );

/** A shard's pattern as a glob: a part of a file (`file:12-40`, `stryker-ranges.mjs`) is its file. */
const globOf = (pattern: string): string => pattern.replace(/:\d+-\d+$/, "");

/** Whether `patterns` (Stryker's `mutate`: globs, `!` leaves a file out) mutate `file`. */
const mutated = (file: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => !pattern.startsWith("!") && matchesGlob(file, globOf(pattern))) &&
  !patterns.some((pattern) => pattern.startsWith("!") && matchesGlob(file, pattern.slice(1)));

/** Whether `entry` of `NON_SHARDED_SRC` names `file`: the file itself, or the directory it is in (`dir/**`). */
const names = (entry: string, file: string): boolean =>
  entry.endsWith("/**") ? file.startsWith(entry.slice(0, -2)) : file === entry;

const reviewedAs = (file: string): string[] =>
  Object.keys(NON_SHARDED_SRC).filter((entry) => names(entry, file));

describe("#1356: the mutation shards cover src/", () => {
  const sources = sourcesOf("src");

  it("every file of src/ is mutated by a shard or reviewed as not", async () => {
    const shards = await shardPatterns;
    const loose = sources.filter((file) => !mutated(file, shards) && reviewedAs(file).length === 0);

    expect(loose).toEqual([]);
  });

  it("a file named as not sharded exists, and no shard mutates it", async () => {
    const shards = await shardPatterns;
    const stale = Object.keys(NON_SHARDED_SRC).filter(
      (entry) => !sources.some((file) => names(entry, file)),
    );
    const sharded = sources.filter((file) => reviewedAs(file).length > 0 && mutated(file, shards));

    expect({ stale, sharded }).toEqual({ stale: [], sharded: [] });
  });

  it("every pattern of a shard matches a file", async () => {
    const empty = (await shardPatterns)
      .filter((pattern) => !pattern.startsWith("!"))
      .filter((pattern) => !sources.some((file) => matchesGlob(file, globOf(pattern))));

    expect(empty).toEqual([]);
  });

  it("a file mutated only in part is mutated by a range, is in no shard whole and says why the rest is not (#1366)", async () => {
    const shards = await shardPatterns;
    const real = new Set(sources);
    const bad = Object.keys(PARTLY_SHARDED_SRC).filter(
      (file) =>
        !real.has(file) ||
        !shards.some((pattern) => pattern.startsWith(`${file}:`)) ||
        shards.includes(file) ||
        reviewedAs(file).length > 0,
    );

    expect(bad).toEqual([]);
  });

  it("every reason says something, in one line", () => {
    const bad = [...Object.entries(NON_SHARDED_SRC), ...Object.entries(PARTLY_SHARDED_SRC)].filter(
      ([, reason]) => reason.trim().length < 10 || reason.includes("\n"),
    );

    expect(bad).toEqual([]);
  });
});

describe("#1356: the readers", () => {
  it("an entry of the reviewed set is a file or a directory, nothing wider", () => {
    expect(names("src/a/x.ts", "src/a/x.ts")).toBe(true);
    expect(names("src/a/x.ts", "src/a/xy.ts")).toBe(false);
    expect(names("src/a/**", "src/a/b/c.ts")).toBe(true);
    expect(names("src/a/**", "src/ab/c.ts")).toBe(false);
  });

  it("a negated pattern and a range leave the file as the shard's config reads it", () => {
    const patterns = ["src/a/**/*.ts", "!src/a/x.ts", "src/b/y.ts:10-20"];

    expect(mutated("src/a/z.ts", patterns)).toBe(true);
    expect(mutated("src/a/x.ts", patterns)).toBe(false);
    expect(mutated("src/b/y.ts", patterns)).toBe(true);
    expect(mutated("src/b/other.ts", patterns)).toBe(false);
  });
});
