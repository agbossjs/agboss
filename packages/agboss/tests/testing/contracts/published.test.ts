/**
 * #481 AC1: the contract suites are published — `@agboss/core/testing/contracts`, an entry of its
 * own with its API report, not loaded by `@agboss/core/testing` — and each function registers the
 * contract's cases under the target's name, as many as the core ran before they were published.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import * as contracts from "../../../src/testing/contracts/index.js";
import { PING_CASE } from "../../../src/testing/contracts/define.js";
import { runContractFixtures, type FixtureRun } from "./fixture-runs.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE = join(PACKAGE_ROOT, "src");

/** The published functions, by the suite title each registers. */
const SUITES: Readonly<Record<string, string>> = {
  checkpointSaverContract: "checkpoint saver contract",
  childExecutionQueueContract: "child execution queue contract",
  costLedgerContract: "cost ledger contract",
  executionHistoryContract: "execution history contract",
  executionLeaseContract: "lease contract",
  executionLeaseEventContract: "lease event contract",
  executionRecordContract: "execution record contract",
  executionTreeContract: "execution tree contract",
  fencedEffectContract: "fenced effect contract",
  meshRequestContract: "mesh request contract",
  pausedExecutionContract: "paused execution contract",
  rateLimitContract: "rate limit contract",
};

/** The store-level cases each contract's suite ran per store before #481 (ping not counted). */
const CASES_BEFORE: Readonly<Record<string, number>> = {
  "checkpoint saver contract": 4,
  "child execution queue contract": 6,
  "cost ledger contract": 4,
  "execution history contract": 4,
  "lease contract": 9,
  "execution record contract": 4,
  "execution tree contract": 6,
  "mesh request contract": 4,
  "paused execution contract": 12,
  "rate limit contract": 8,
};

/** Every module of src/ that `entry` loads, statically or by `import()`. */
function modulesOf(entry: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    for (const { fileName } of importedFiles) {
      if (!fileName.startsWith(".")) continue;
      const target = resolve(dirname(file), fileName.replace(/\.js$/, ".ts"));
      if (existsSync(target)) pending.push(target);
    }
  }
  return seen;
}

const isContractModule = (file: string): boolean =>
  file.includes(join("src", "testing", "contracts"));

describe("#481 AC1: the published entry", () => {
  it("package.json exports @agboss/core/testing/contracts from the build, with its API report", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"));
    const report = readFileSync(
      join(PACKAGE_ROOT, "api", "agboss-testing-contracts.api.md"),
      "utf8",
    );

    expect(pkg.exports["./testing/contracts"]).toEqual({
      types: "./dist/testing/contracts/index.d.ts",
      import: "./dist/testing/contracts/index.js",
    });
    for (const name of [...Object.keys(SUITES), "ContractTarget", "StoreSeam"]) {
      expect(report).toContain(name);
    }
  });

  it("exports one function per contract, and nothing else at run time", () => {
    expect(Object.keys(contracts).sort()).toEqual(Object.keys(SUITES).sort());
    for (const register of Object.values(contracts)) expect(register).toBeTypeOf("function");
  });

  it("@agboss/core/testing does not pull it in: no module of the suites in its module graph", () => {
    const testing = modulesOf(join(SOURCE, "testing", "index.ts"));
    const published = modulesOf(join(SOURCE, "testing", "contracts", "index.ts"));

    expect(testing.size).toBeGreaterThan(50);
    expect([...testing].filter(isContractModule)).toEqual([]);
    // the check sees the suites where they are: from their own entry
    expect([...published].filter(isContractModule).length).toBeGreaterThan(10);
  });

  it("the root entry and /testing do not export a contract suite", async () => {
    const root = await import("../../../src/index.js");
    const testing = await import("../../../src/testing/index.js");

    for (const name of Object.keys(SUITES)) {
      expect(name in root).toBe(false);
      expect(name in testing).toBe(false);
    }
  });
});

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["every-contract.contract-fixture.ts"]);
}, 120_000);

/** The cases run under `suite`. */
const casesUnder = (suite: string) => run.cases.filter((found) => found.suites[0] === suite);

describe("#481 AC1: each contract registers its cases under the target's name", () => {
  it("each function registers its suite as `<contract> (<target name>)`, every case passing", () => {
    const suites = new Set(run.cases.map((found) => found.suites[0]));

    expect(run.isFailed).toBe(false);
    expect(suites).toEqual(
      new Set(Object.values(SUITES).map((title) => `${title} (fixture-store)`)),
    );
    expect(run.cases.filter((found) => found.state !== "pass")).toEqual([]);
  });

  it("every suite ends with the ping case", () => {
    for (const title of Object.values(SUITES)) {
      expect(casesUnder(`${title} (fixture-store)`).at(-1)?.name).toBe(PING_CASE);
    }
  });

  it("regression: no contract runs fewer cases per store than the core ran before #481", () => {
    for (const [title, before] of Object.entries(CASES_BEFORE)) {
      expect(casesUnder(`${title} (fixture-store)`).length, title).toBeGreaterThanOrEqual(
        before + 1,
      );
    }
  });

  it("case names are the core's: the lease contract's cases read as they did", () => {
    const lease = casesUnder("lease contract (fixture-store)");

    expect(lease.map((found) => [...found.suites.slice(1), found.name].join(" > "))).toEqual([
      "a tree's lease held by one instance is not given to the other",
      "past the lease the other takes it with leaseEpoch + 1, and the old holder's renew is false",
      "a lease renewed exactly at expiry, not taken meanwhile, is kept",
      "a released lease is taken at once with leaseEpoch + 1; another tenant's tree is its own",
      "acquire after expiry reports the previous holder; after release it does not",
      "a holder that takes its own expired lease back reports itself as the previous holder",
      "releasing a lost lease leaves the new holder's",
      "the framework's holder of a tree's lease > a holder frozen past the lease loses it to the waiting instance: its signal aborts",
      "the framework's holder of a tree's lease > a live holder renews every third of the lease: the waiting call waits",
      "the framework's holder of a tree's lease > a release wakes the waiting call at once, without the clock",
      "the framework's holder of a tree's lease > the caller's signal ends the wait with its reason",
      PING_CASE,
    ]);
  });
});
