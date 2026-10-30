/**
 * #509 — `scripts/flaky-probe.mjs`: runs one test file N times, each cold (a vitest process of its
 * own, `--no-cache`), and says how many passed. Its pure parts here, then the whole command on a
 * passing and a failing test file in a scratch project of their own.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const repo = new URL("../../../../", import.meta.url).pathname;

interface ProbeRun {
  readonly passed: boolean;
  readonly seconds: number;
}
interface ProbeSummary {
  readonly passed: number;
  readonly runs: number;
  readonly line: string;
}
interface FlakyProbe {
  readonly UsageError: new (message: string) => Error;
  readonly parseArguments: (args: readonly string[]) => { readonly runs?: number };
  readonly projectOf: (file: string) => string;
  readonly summaryOf: (results: readonly ProbeRun[]) => ProbeSummary;
}
const { UsageError, parseArguments, projectOf, summaryOf } = (await import(
  join(repo, "scripts/flaky-probe.mjs")
)) as FlakyProbe;
const scratch = mkdtempSync(join(tmpdir(), "agboss-flaky-probe-"));

interface Ran {
  readonly status: number | null;
  readonly out: string;
}

const flakyProbe = (...args: string[]): Ran => {
  const result = spawnSync(process.execPath, [join(repo, "scripts/flaky-probe.mjs"), ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

/** A project of its own: a vitest config (globals, no imports) and one test file. */
const projectWith = (name: string, body: string): string => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(
    join(dir, "vitest.config.mjs"),
    'export default { test: { include: ["tests/*.test.mjs"], globals: true } };\n',
  );
  const file = join(dir, "tests", "probed.test.mjs");
  writeFileSync(file, `it("probed", () => { ${body} });\n`);
  return file;
};

/** Each case below spawns whole vitest processes: seconds each on a loaded runner, never a race. */
const SPAWNS = { timeout: 60_000 };

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("#509 AC1: flaky-probe's command line", () => {
  it("AC1: <test file> <runs> is read; --help is help", () => {
    expect(parseArguments(["a.test.ts", "50"])).toMatchObject({ runs: 50 });
    expect(parseArguments(["--help"])).toEqual({ help: true });
  });

  it("AC1: missing, extra or unknown arguments and a wrong count are usage errors", () => {
    expect(() => parseArguments(["a.test.ts"])).toThrow(UsageError);
    expect(() => parseArguments(["a.test.ts", "2", "3"])).toThrow(UsageError);
    expect(() => parseArguments(["a.test.ts", "2", "--fast"])).toThrow("unknown argument: --fast");
    expect(() => parseArguments(["a.test.ts", "0"])).toThrow(
      "runs must be a whole number ≥ 1, got 0",
    );
    expect(() => parseArguments(["a.test.ts", "1.5"])).toThrow(UsageError);
  });

  it("AC1: a usage error exits 2 with its message; --help exits 0 with the usage", SPAWNS, () => {
    expect(flakyProbe("x.test.ts", "zero")).toMatchObject({ status: 2 });
    expect(flakyProbe("no-such.test.ts", "1").out).toContain("no such test file");
    const help = flakyProbe("--help");
    expect(help.status).toBe(0);
    expect(help.out).toContain("usage: node scripts/flaky-probe.mjs <test file> <runs>");
  });
});

describe("#509 AC1: what flaky-probe reports", () => {
  it("AC1: the summary counts the passed runs, with the median and the slowest real time", () => {
    const summary = summaryOf([
      { passed: true, seconds: 2 },
      { passed: false, seconds: 5 },
      { passed: true, seconds: 1 },
    ]);

    expect(summary).toEqual({
      passed: 2,
      runs: 3,
      line: "flaky-probe: 2/3 passed (median 2.00 s, slowest 5.00 s)",
    });
  });

  it("AC1: a test file runs in the folder of the nearest vitest config above it", () => {
    const file = projectWith("nearest", "expect(1).toBe(1);");

    expect(projectOf(file)).toBe(join(scratch, "nearest"));
    expect(() => projectOf("/no-config-anywhere/a.test.ts")).toThrow("no vitest config above");
  });

  it("AC1: every cold run passed → exit 0 and N/N", SPAWNS, () => {
    const ran = flakyProbe(projectWith("passing", "expect(1).toBe(1);"), "2");

    expect(ran.status).toBe(0);
    expect(ran.out).toContain("run 2: passed");
    expect(ran.out).toContain("flaky-probe: 2/2 passed");
  });

  it("AC1: a failing run → exit 1, its output printed", SPAWNS, () => {
    const ran = flakyProbe(projectWith("failing", "expect(1).toBe(2);"), "1");

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("run 1: FAILED");
    expect(ran.out).toContain("flaky-probe: 0/1 passed");
  });
});
