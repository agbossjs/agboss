/**
 * #1186 — the nightly cold mutation run covers every shard the PR run does. `mutation-nightly.yml`
 * once missed `a2a-direct`, so the run that trusts no cache never touched it. Both workflows take their shards from
 * the plan (`scripts/mutation-changed.mjs`, which reads `stryker.config.mjs`: every shard, the ones a dispatch names,
 * or the touched ones, never a list of their own); the plan's `--shards all` must be the config's set.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../helpers/process.js";

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

/** What `node scripts/mutation-changed.mjs <args>` prints and whether it succeeded. */
async function plan(
  ...args: string[]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // inside GitHub Actions the plan writes `shards=` to $GITHUB_OUTPUT's file: here it must print
  const env = { ...process.env };
  delete env.GITHUB_OUTPUT;
  return runProcess("node", [join(repo, "scripts/mutation-changed.mjs"), ...args], {
    cwd: repo,
    env,
  });
}

describe("#1186: the mutation workflows run the shards stryker.config.mjs defines", () => {
  const defined = shardsOfStryker(read("packages/agboss/stryker.config.mjs"));

  it("`--shards all` (the nightly) is every shard the config defines, once", async () => {
    const run = await plan("--shards", "all", "--github-output");
    const listed = JSON.parse(/^shards=(.*)$/m.exec(run.stdout)?.[1] ?? "null") as string[];

    expect(defined.length).toBeGreaterThan(10);
    expect(new Set(listed).size).toBe(listed.length);
    expect(sorted(listed)).toEqual(sorted(defined));
  });

  it("`--shards a,b` (a dispatch) is those shards, and a name that is no shard fails", async () => {
    const some = await plan("--shards", "fence-tree,mesh-charge", "--github-output");
    const bad = await plan("--shards", "fence-tree,no-such-shard", "--github-output");

    expect(some.stdout).toContain('shards=["fence-tree","mesh-charge"]');
    expect({
      status: bad.status,
      stderr: bad.stderr.includes("no mutation shard no-such-shard"),
    }).toEqual({
      status: 1,
      stderr: true,
    });
  });

  it("both workflows take their shards from the plan, in the reusable job, never from a list of their own", () => {
    for (const file of ["ci.yml", "mutation-nightly.yml"]) {
      const workflow = read(`.github/workflows/${file}`);

      expect(workflow).toContain("uses: ./.github/workflows/mutation-shards.yml");
      expect(() => shardsOfWorkflow(workflow)).toThrow(/no `shard/);
    }
    expect(read(".github/workflows/mutation-shards.yml")).toContain(
      "shard: ${{ fromJSON(inputs.shards) }}",
    );
  });

  it("a pull request's `check` waits for the shards, and they block it only when MUTATION_BLOCKING is true", () => {
    const pull = read(".github/workflows/ci.yml");

    expect(pull).toContain(
      "needs: [static, tests, coverage, packages, engines-floor, mutation-plan, mutation]",
    );
    expect(pull).toContain("MUTATION_BLOCKING: ${{ vars.MUTATION_BLOCKING }}");
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

describe("the shard summary (scripts/mutation-summary.mjs)", () => {
  it("lists the survivors and the lines no test runs as file:line, with the score", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mutation-summary-"));
    const report = join(dir, "demo.json");
    const at = (line: number): object => ({ start: { line, column: 1 }, end: { line, column: 5 } });
    writeFileSync(
      report,
      JSON.stringify({
        files: {
          "src/a.ts": {
            mutants: [
              { status: "Killed", mutatorName: "X", location: at(1) },
              {
                status: "Survived",
                mutatorName: "ConditionalExpression",
                replacement: "true",
                location: at(12),
              },
              {
                status: "NoCoverage",
                mutatorName: "StringLiteral",
                replacement: '""',
                location: at(30),
              },
            ],
          },
        },
      }),
    );
    const run = await runProcess("node", [
      join(repo, "scripts/mutation-summary.mjs"),
      "--shard",
      "demo",
      report,
    ]);

    expect(run.stdout).toContain(
      "### mutation shard demo: 33.33 % (Killed 1, Survived 1, NoCoverage 1, Timeout 0)",
    );
    expect(run.stdout).toContain("src/a.ts:12 Survived ConditionalExpression -> true");
    expect(run.stdout).toContain('src/a.ts:30 NoCoverage StringLiteral -> ""');
  });
});
