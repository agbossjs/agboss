/**
 * #1367: a Stryker Timeout is a hang, and an error is not a pass. `scripts/stryker-timeouts.mjs` fails a shard's
 * JSON report that holds a Timeout, a RuntimeError or a CompileError nobody justified (a survivor reads as a
 * Timeout when its run outlasts Stryker's limit, agbossjs/mongodb#103; Stryker leaves the errors out of its
 * score), and an entry of the proven list that matches none of its shard's mutants; `stryker.config.mjs`
 * gives every shard its own `timeoutMS` and a `timeoutFactor`, and every mutation vitest config its own
 * `testTimeout` and `hookTimeout`, none a `testNamePattern`.
 */
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runProcess } from "../helpers/process.js";

const pkg = new URL("../../", import.meta.url).pathname;
const script = join(pkg, "../../scripts/stryker-timeouts.mjs");

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "stryker-timeouts-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface Mutant {
  readonly id: string;
  readonly mutatorName: string;
  readonly status: string;
  readonly statusReason?: string;
  readonly replacement: string;
  readonly location: { readonly start: { readonly line: number; readonly column: number } };
}

const mutant = (
  id: string,
  mutatorName: string,
  line: number,
  status: string,
  statusReason?: string,
): Mutant => ({
  id,
  mutatorName,
  status,
  ...(statusReason === undefined ? {} : { statusReason }),
  replacement: "{}",
  location: { start: { line, column: 1 } },
});

/** A file of a report: its source (the lines the mutants are on) and its mutants. */
interface FileReport {
  source: string;
  mutants: Mutant[];
}
const LOOP = "for (;;) {\n  retry();\n  if (stopped()) return;\n}\n";

/** The script on the report `<shard>.json` holding `files` and a proven list; its exit code and what it said. */
async function checked(
  files: Record<string, FileReport>,
  hangs: readonly Record<string, unknown>[],
  shard = "leases",
  flags: readonly string[] = [],
): Promise<{ code: number | null; said: string }> {
  const report = join(dir, `${shard}.json`);
  const list = join(dir, "hangs.json");
  fs.writeFileSync(
    report,
    JSON.stringify({
      schemaVersion: "2",
      files: Object.fromEntries(
        Object.entries(files).map(([name, file]) => [name, { language: "typescript", ...file }]),
      ),
    }),
  );
  fs.writeFileSync(list, JSON.stringify(hangs));
  const run = await runProcess("node", [script, ...flags, "--hangs", list, report]);
  return { code: run.status, said: run.stdout + run.stderr };
}

const HIT = "Hit limit reached (1000/100)";
const HANG = {
  shard: "leases",
  file: "src/loop.ts",
  mutator: "BlockStatement",
  replacement: "{}",
  anchor: "retry();",
  kind: "hit-limit",
  reason: "the retry loop's body is {}: the loop never ends",
};
/** The loop's mutant, as a Timeout Stryker's hit limit ended, on the loop's second line. */
const hung = (line = 2, id = "3"): Record<string, FileReport> => ({
  "src/loop.ts": { source: LOOP, mutants: [mutant(id, "BlockStatement", line, "Timeout", HIT)] },
});

describe("scripts/stryker-timeouts.mjs", () => {
  it("passes a report with no Timeout or error, whatever else it holds", async () => {
    const run = await checked(
      {
        "src/a.ts": {
          source: "a\nb\n",
          mutants: [
            mutant("1", "StringLiteral", 1, "Killed"),
            mutant("2", "StringLiteral", 2, "Survived"),
          ],
        },
      },
      [],
    );

    expect(run.said).toContain("no Timeout or error of");
    expect(run.code).toBe(0);
  });

  it("fails a Timeout nobody proved, naming the file, line, mutator, kind and what to do", async () => {
    const run = await checked(hung(2, "7"), []);

    expect(run.code).toBe(1);
    expect(run.said).toMatch(
      /src\/loop\.ts:2: Timeout \(hit-limit\) of a BlockStatement mutant -> \{\} \[Hit limit reached \(1000\/100\)\]; line: retry\(\);/,
    );
    expect(run.said).toContain("run it alone with a limit of 3 x the shard's run");
  });

  it("calls a Timeout with no hit limit a wall-clock one", async () => {
    const files = {
      "src/loop.ts": { source: LOOP, mutants: [mutant("3", "BlockStatement", 2, "Timeout")] },
    };

    const unlisted = await checked(files, []);
    const asHit = await checked(files, [HANG]);
    const listed = await checked(files, [{ ...HANG, kind: "wall-clock" }]);

    expect(unlisted.said).toContain("Timeout (wall-clock)");
    expect(asHit.code).toBe(1);
    expect(listed.code).toBe(0);
  });

  it("passes a Timeout on the list, wherever its line and id are now", async () => {
    const run = await checked(
      {
        "src/loop.ts": {
          source: `// moved down\n// by an edit\n${LOOP}`,
          mutants: [mutant("912", "BlockStatement", 4, "Timeout", HIT)],
        },
      },
      [HANG],
    );

    expect(run.code).toBe(0);
    expect(run.said).toContain("1 listed");
  });

  it.each([
    ["another shard", { ...HANG, shard: "other" }],
    ["another file", { ...HANG, file: "src/other.ts" }],
    ["another mutator", { ...HANG, mutator: "StringLiteral" }],
    ["another replacement", { ...HANG, replacement: "false" }],
    ["another anchor", { ...HANG, anchor: "somethingElse();" }],
    ["another kind", { ...HANG, kind: "wall-clock" }],
  ])("fails a Timeout whose %s is the one listed", async (_name, entry) => {
    const run = await checked({ ...hung(), "src/other.ts": { source: "x\n", mutants: [] } }, [
      entry,
    ]);

    expect(run.code).toBe(1);
    expect(run.said).toContain("Timeout (hit-limit)");
  });

  it("fails an entry of the report's shard that matches no mutant: stale; leaves another shard's entry", async () => {
    const files = {
      "src/loop.ts": { source: LOOP, mutants: [mutant("3", "BlockStatement", 2, "Killed")] },
    };

    const own = await checked(files, [HANG]);
    const other = await checked(files, [{ ...HANG, shard: "other" }]);
    const partial = await checked(files, [HANG], "leases", ["--partial"]);

    expect(own.code).toBe(1);
    expect(own.said).toMatch(
      /PROVEN_HANGS has src\/loop\.ts BlockStatement -> \{\} \(hit-limit, "retry\(\);"\).*stale/,
    );
    expect(other.code).toBe(0);
    expect(partial.code).toBe(0);
  });

  it.each([
    ["RuntimeError", "runtime-error"],
    ["CompileError", "compile-error"],
  ])("fails a %s nobody justified, and passes it once listed", async (status, kind) => {
    const files = {
      "src/loop.ts": { source: LOOP, mutants: [mutant("3", "BlockStatement", 2, status)] },
    };

    const unlisted = await checked(files, []);
    const listed = await checked(files, [{ ...HANG, kind, reason: "the index it makes clashes" }]);

    expect(unlisted.code).toBe(1);
    expect(unlisted.said).toContain(`${status} (${kind})`);
    expect(listed.code).toBe(0);
  });

  it.each([
    ["no reason", { ...HANG, reason: " " }, /needs reason/],
    ["no anchor", { ...HANG, anchor: undefined }, /needs anchor/],
    ["no shard", { ...HANG, shard: "" }, /needs shard/],
    ["an unknown kind", { ...HANG, kind: "slow" }, /kind "slow" is none of/],
  ])("fails a list entry with %s", async (_name, entry, said) => {
    const run = await checked({ "src/a.ts": { source: "", mutants: [] } }, [entry]);

    expect(run.code).toBe(1);
    expect(run.said).toMatch(said);
  });

  it("fails an entry listed twice", async () => {
    const run = await checked(hung(), [HANG, HANG]);

    expect(run.code).toBe(1);
    expect(run.said).toContain("is listed twice");
  });

  it("the proven list of the repo is well formed: every entry has its fields and reason, none twice", async () => {
    const report = join(dir, "no-such-shard.json");
    fs.writeFileSync(report, JSON.stringify({ files: {} }));

    const run = await runProcess("node", [script, report]);

    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
  });

  it("fails a file that is no Stryker report", async () => {
    const report = join(dir, "other.json");
    fs.writeFileSync(report, "{}");

    const run = await runProcess("node", [script, report]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("not a Stryker JSON report");
  });

  it("reports every unjustified mutant in one run, across reports", async () => {
    const body = (line: number): string =>
      JSON.stringify({
        files: {
          "src/a.ts": {
            source: "a\nb\n",
            mutants: [mutant("1", "StringLiteral", line, "Timeout")],
          },
        },
      });
    fs.writeFileSync(join(dir, "one.json"), body(1));
    fs.writeFileSync(join(dir, "two.json"), body(2));

    const run = await runProcess("node", [script, join(dir, "one.json"), join(dir, "two.json")]);

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("one.json: src/a.ts:1");
    expect(run.stderr).toContain("two.json: src/a.ts:2");
  });
});

describe("#1367: the mutation configs", () => {
  it("every shard has a timeoutMS of 60 s or more, a timeoutFactor is set, and each entry names a shard", async () => {
    const run = await runProcess(
      "node",
      [
        "--input-type=module",
        "-e",
        "const { SHARDS } = await import(process.argv[1]);" +
          "const { TIMEOUTS_MS } = await import(process.argv[2]);" +
          "const config = (await import(process.argv[1])).default;" +
          "console.log(JSON.stringify({ shards: Object.keys(SHARDS), timeouts: TIMEOUTS_MS, factor: config.timeoutFactor }));",
        join(pkg, "stryker.config.mjs"),
        join(pkg, "../../scripts/stryker-timeouts-ms.mjs"),
      ],
      { cwd: pkg },
    );
    expect(run.status).toBe(0);
    const { shards, timeouts, factor } = JSON.parse(run.stdout) as {
      shards: string[];
      timeouts: Record<string, number>;
      factor: number;
    };

    expect(Object.keys(timeouts).sort()).toEqual([...shards].sort());
    for (const [shard, ms] of Object.entries(timeouts))
      expect(ms, shard).toBeGreaterThanOrEqual(60_000);
    expect(factor).toBeGreaterThanOrEqual(3);
  });

  it("every entry of the proven list names a shard of the config (or the CLI's)", async () => {
    const list = JSON.parse(
      fs.readFileSync(join(pkg, "../../scripts/stryker-proven-hangs.json"), "utf8"),
    ) as { shard: string }[];
    const run = await runProcess(
      "node",
      [
        "--input-type=module",
        "-e",
        "const { SHARDS } = await import(process.argv[1]);console.log(JSON.stringify(Object.keys(SHARDS)));",
        join(pkg, "stryker.config.mjs"),
      ],
      { cwd: pkg },
    );
    const shards = new Set([...(JSON.parse(run.stdout) as string[]), "cli-stream"]);

    expect(list.length).toBeGreaterThan(0);
    for (const { shard } of list) expect(shards.has(shard), shard).toBe(true);
  });

  it("every vitest.mutation*.config.ts sets testTimeout and hookTimeout, and none a testNamePattern", () => {
    const configs = fs
      .readdirSync(pkg)
      .filter((name) => /^vitest\.mutation.*\.config\.ts$/.test(name));

    expect(configs.length).toBeGreaterThan(10);
    for (const name of configs) {
      const text = fs.readFileSync(join(pkg, name), "utf8");
      expect(text, name).toMatch(/^\s*testTimeout: [\d_]+,$/m);
      expect(text, name).toMatch(/^\s*hookTimeout: [\d_]+,$/m);
      // vitest keeps a config's pattern as an override of Stryker's per-mutant one: every mutant ran every test
      expect(text, name).not.toMatch(/^\s*testNamePattern:/m);
    }
  });
});
