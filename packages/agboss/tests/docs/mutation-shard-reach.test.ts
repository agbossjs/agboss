/**
 * Nightly root cause 2026-11-27 (#1356): a shard's tests must reach what the shard mutates, or its mutants are
 * NoCoverage and the shard is red at its first run. `scripts/check-mutation-reach.mjs` runs a shard's tests under
 * coverage (a dry run, minutes for all, so it runs in the PR's mutation job, the nightly and
 * `npm run test:mutation:changed`, not in `check:static`); this test holds what is static and cheap: the include
 * lists name tests that exist, and the reader of the coverage flags what no test ran.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../helpers/process.js";

const pkg = new URL("../../", import.meta.url).pathname;
const scripts = join(pkg, "../../scripts");

/** Runs `code` (an ES module body) in node and returns the JSON it prints. */
async function evaluate<T>(code: string): Promise<T> {
  const run = await runProcess("node", ["--input-type=module", "-e", code], { cwd: pkg });
  if (run.status !== 0) throw new Error(run.stderr);
  return JSON.parse(run.stdout) as T;
}

describe("the include lists of the mutation shards", () => {
  it("every pattern of every shard's vitest config matches a test file", async () => {
    const stale = await evaluate<string[]>(
      `import { globSync } from "node:fs";
       import { readShards, includeOf } from ${JSON.stringify(join(scripts, "mutation-shards.mjs"))};
       const shards = await readShards();
       const stale = [];
       for (const [name, shard] of Object.entries(shards))
         for (const pattern of includeOf(shard.configFile))
           if (globSync(pattern, { cwd: process.cwd() }).length === 0) stale.push(name + ": " + pattern);
       console.log(JSON.stringify(stale));`,
    );

    expect(stale).toEqual([]);
  });

  it("every shard runs at least one test and mutates at least one file", async () => {
    const empty = await evaluate<string[]>(
      `import { readShards, testsOfShard, mutatedFilesOf } from ${JSON.stringify(join(scripts, "mutation-shards.mjs"))};
       const shards = await readShards();
       console.log(JSON.stringify(Object.entries(shards)
         .filter(([, shard]) => testsOfShard(shard).length === 0 || mutatedFilesOf(shard).size === 0)
         .map(([name]) => name)));`,
    );

    expect(empty).toEqual([]);
  });
});

describe("the reach check reads coverage", () => {
  const coverage = {
    "/p/src/a.ts": {
      fnMap: {
        "0": { loc: { start: { line: 1 }, end: { line: 5 } } },
        "1": { loc: { start: { line: 20 }, end: { line: 30 } } },
      },
      f: { "0": 3, "1": 0 },
      statementMap: {
        "0": { start: { line: 2 }, end: { line: 2 } },
        "1": { start: { line: 22 }, end: { line: 22 } },
      },
      s: { "0": 3, "1": 0 },
    },
    "/p/src/b.ts": {
      fnMap: { "0": { loc: { start: { line: 1 }, end: { line: 5 } } } },
      f: { "0": 0 },
      statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
      s: { "0": 1 },
    },
    "/p/src/consts.ts": {
      fnMap: {},
      f: {},
      statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
      s: { "0": 0 },
    },
  };

  const missed = (files: [string, number[][] | null][]): Promise<string[]> =>
    evaluate<string[]>(
      `import { unreached } from ${JSON.stringify(join(scripts, "check-mutation-reach.mjs"))};
       console.log(JSON.stringify(unreached(${JSON.stringify(coverage)}, new Map(${JSON.stringify(files)}), "/p")));`,
    );

  it("flags a file no test loaded, a file none of whose functions ran, and a file without functions none of whose statements ran", async () => {
    expect(
      await missed([
        ["src/a.ts", null],
        ["src/b.ts", null],
        ["src/none.ts", null],
        ["src/consts.ts", null],
      ]),
    ).toEqual(["src/b.ts", "src/none.ts", "src/consts.ts"]);
  });

  it("reads only the range of a file a shard mutates in part", async () => {
    expect(await missed([["src/a.ts", [[1, 5]]]])).toEqual([]);
    expect(await missed([["src/a.ts", [[20, 30]]]])).toEqual(["src/a.ts:20-30"]);
    expect(
      await missed([
        [
          "src/a.ts",
          [
            [20, 30],
            [1, 5],
          ],
        ],
      ]),
    ).toEqual([]);
  });
});
