/**
 * #1186 — the nightly cold mutation run covers every shard the PR run does. `mutation-nightly.yml`
 * once missed `a2a-direct`, so the run that trusts no cache never touched it. The shard lists of the
 * two workflows, and the shards `stryker.config.mjs` defines, must be one set.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(repo, path), "utf8");

/** The names of a workflow's `matrix.shard: [ … ]` list (the mutation job's matrix). */
const shardsOfWorkflow = (workflow: string): string[] => {
  const list = /^\s*shard:\s*\[([^\]]*)\]/m.exec(workflow)?.[1];
  if (list === undefined) throw new Error("no `shard: [ … ]` matrix list in the workflow");
  return list
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
};

/**
 * The shard names `stryker.config.mjs` defines: the keys of its `SHARDS` object, at two spaces — an
 * object, or one a function of a `stryker-ranges*.mjs` module builds (`ranges.filesPiiShard()`, #1269;
 * `core.fencingShard()`, `a2a.streamShard()`, #1376).
 */
const shardsOfStryker = (config: string): string[] => {
  const body = /(?:export )?const SHARDS = \{\n([\s\S]*?)\n\};\n/.exec(config)?.[1];
  if (body === undefined) throw new Error("no `const SHARDS = { … };` in stryker.config.mjs");
  return [...body.matchAll(/^ {2}"?([\w-]+)"?: (?:\{|\w+\.\w+\(\),)$/gm)].map(
    (found) => found[1] ?? "",
  );
};

const sorted = (names: readonly string[]): string[] => [...names].sort();

describe("#1186: the nightly mutation matrix is the PR mutation matrix", () => {
  const pull = shardsOfWorkflow(read(".github/workflows/ci.yml"));
  const nightly = shardsOfWorkflow(read(".github/workflows/mutation-nightly.yml"));
  const defined = shardsOfStryker(read("packages/agboss/stryker.config.mjs"));

  it("lists the same shards, none twice", () => {
    expect(new Set(nightly).size).toBe(nightly.length);
    expect(sorted(nightly)).toEqual(sorted(pull));
  });

  it("the PR list has every shard stryker.config.mjs defines, and nothing it does not", () => {
    expect(defined.length).toBeGreaterThan(10);
    expect(sorted(pull)).toEqual(sorted(defined));
  });
});

describe("#1186: the readers", () => {
  it("read a matrix list across lines, and a SHARDS object with quoted keys", () => {
    expect(
      shardsOfWorkflow(
        "        shard:\n          [\n            a,\n            b-c,\n          ]\n",
      ),
    ).toEqual(["a", "b-c"]);
    expect(
      shardsOfStryker(
        'const SHARDS = {\n  // note\n  a: {\n    x: 1,\n  },\n  "b-c": {\n  },\n  "d-e": ranges.dShard(),\n  f: core.fShard(),\n};\n',
      ),
    ).toEqual(["a", "b-c", "d-e", "f"]);
  });

  it("refuse a file where they find no list, so a renamed key cannot pass as an empty equal list", () => {
    expect(() => shardsOfWorkflow("jobs: {}")).toThrow(/no `shard/);
    expect(() => shardsOfStryker("export default {}")).toThrow(/no `const SHARDS/);
  });
});
