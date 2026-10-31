/**
 * #481 AC1, #526 AC2: the contract suites are published — `@agboss/core/testing/contracts`, an entry of its
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
  outboundCallContract: "outbound call contract",
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
    for (const name of [
      ...Object.keys(SUITES),
      "ContractTarget",
      "StoreSeam",
      "storeConformance",
      "StoreConformanceOptions",
      "ConformanceStores",
      "StoreConformanceError",
    ]) {
      expect(report).toContain(name);
    }
  });

  it("exports one function per contract, storeConformance and its error (#526), nothing else at run time", () => {
    expect(Object.keys(contracts).sort()).toEqual(
      [...Object.keys(SUITES), "storeConformance", "StoreConformanceError"].sort(),
    );
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

    for (const name of [...Object.keys(SUITES), "storeConformance", "StoreConformanceError"]) {
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
  it("storeConformance registers each suite as `<contract> (<target name>)` and the store set's, every case passing", () => {
    const suites = new Set(run.cases.map((found) => found.suites[0]));

    expect(run.isFailed).toBe(false);
    expect(suites).toEqual(
      new Set([
        ...Object.values(SUITES).map((title) => `${title} (fixture-store)`),
        "store set (fixture-store)",
      ]),
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
      "a released lease is taken at once with leaseEpoch + 1; another tenant's tree is its own",
      "acquire after expiry reports the previous holder; after release it does not",
      "a holder that takes its own expired lease back reports itself as the previous holder",
      "releasing a lost lease leaves the new holder's",
      "a yielded lease > a yielded lease blocks another acquire until it expires",
      "a yielded lease > a renewal keeps a yielded lease past its first expiry, still yielded",
      "a yielded lease > the holder reclaims its yielded lease at leaseEpoch + 1: held again, the old epoch's renew false",
      "a yielded lease > a held lease is reclaimed too: the holder that never yielded moves to leaseEpoch + 1",
      "a yielded lease > an expired yielded lease is taken over with takenOverFrom; the old holder's reclaim, renew and yield then fail",
      "a yielded lease > a reclaim racing a takeover attempt: the holder wins while its lease is valid",
      "a yielded lease > a yielded lease its holder releases is free at once, with no previous holder",
      "a yielded lease > only the holder's own lease yields: another instance's, a released one and another tenant's tree do not",
      "a yielded lease > a yielded lease 1 ms before its expiry still blocks another acquire",
      "a yielded lease > an expired yielded lease, reclaimed and taken at once: exactly one instance holds it",
      "a yielded lease > a lease yielded twice is one yielded lease: both answer true, another acquire is refused",
      "a yielded lease > after a reclaim the old epoch is stale: its yield, reclaim and renew are refused",
      "the lease's expiry, for its holder too > #534: renew of a held lease 1 ms before its expiry, not taken meanwhile, is kept",
      "the lease's expiry, for its holder too > #534: renew of a held lease exactly at its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: renew of a held lease 1 ms after its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: renew of a yielded lease 1 ms before its expiry, not taken meanwhile, is kept",
      "the lease's expiry, for its holder too > #534: renew of a yielded lease exactly at its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: renew of a yielded lease 1 ms after its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: reclaim of a yielded lease 1 ms before its expiry, not taken meanwhile, is kept",
      "the lease's expiry, for its holder too > #534: reclaim of a yielded lease exactly at its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: reclaim of a yielded lease 1 ms after its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: yield of a held lease 1 ms before its expiry, not taken meanwhile, is kept",
      "the lease's expiry, for its holder too > #534: yield of a held lease exactly at its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: yield of a held lease 1 ms after its expiry, not taken meanwhile, is refused: the lease is over for its holder too",
      "the lease's expiry, for its holder too > #534: a holder refused exactly at its expiry takes its tree again only by acquire — a new epoch, taken over from itself — and its old lease stays refused",
      "the lease's expiry, for its holder too > #534: a holder refused 1 ms after its expiry takes its tree again only by acquire — a new epoch, taken over from itself — and its old lease stays refused",
      "the lease's expiry, for its holder too > #534: exactly at its expiry another instance's take and the holder's renewal never both win — the take stands, the renewal is refused, in either order",
      "the lease's expiry, for its holder too > #534: a renewal racing another instance's take 1 ms before its expiry: exactly one wins — the holder",
      "the lease's expiry, for its holder too > #534: a renewal racing another instance's take exactly at its expiry: exactly one wins — the taker",
      "the lease's expiry, for its holder too > #534: a renewal racing another instance's take 1 ms after its expiry: exactly one wins — the taker",
      "the lease's expiry, for its holder too > #534: a reclaim of a yielded lease racing another instance's take 1 ms before its expiry: exactly one wins — the holder",
      "the lease's expiry, for its holder too > #534: a reclaim of a yielded lease racing another instance's take exactly at its expiry: exactly one wins — the taker",
      "the lease's expiry, for its holder too > #534: a reclaim of a yielded lease racing another instance's take 1 ms after its expiry: exactly one wins — the taker",
      "the lease's expiry, for its holder too > #534: a renewal 29.999 s into the lease moves its end to a lease after the renewal, not a lease after the old end",
      "the store's time is the authority > #533: with the other instance's clock 0.5 × lease ahead, the store's time decides — no take of a live lease, the take of an expired one on time",
      "the store's time is the authority > #533: with the other instance's clock 0.5 × lease behind, the store's time decides — no take of a live lease, the take of an expired one on time",
      "the store's time is the authority > #533: with the other instance's clock 1 × lease ahead, the store's time decides — no take of a live lease, the take of an expired one on time",
      "the store's time is the authority > #533: with the other instance's clock 1 × lease behind, the store's time decides — no take of a live lease, the take of an expired one on time",
      "the store's time is the authority > #533: with the other instance's clock 10 × lease ahead, the store's time decides — no take of a live lease, the take of an expired one on time",
      "the store's time is the authority > #533: with the other instance's clock 10 × lease behind, the store's time decides — no take of a live lease, the take of an expired one on time",
      "a finished lease > a finished lease is never taken again: not by another instance, not by its holder, not after it would have expired",
      "a finished lease > a finished lease is renewed, yielded and reclaimed no more",
      "a finished lease > a yielded lease its holder finishes is never taken again",
      "a finished lease > a release after the finish leaves it finished",
      "a finished lease > finishing a lost lease keeps the new holder's and finishes nothing",
      "a finished lease > another tenant's tree of the same id is not finished with it",
      "a finished lease > a race of the finish and another instance's acquire while the lease is valid: the acquire is refused either way",
      "a finished lease > a race of the finish and another instance's acquire past the lease: the acquire takes it first (the finish then a no-op) or is refused for good — never both",
      "a finished lease > #520: a finish with the epoch before its holder's release and new take finishes nothing — the newer lease stays held, then free",
      "a finished lease > #520: a finish with the epoch before a reclaim finishes nothing — the reclaimed lease stays held, then free",
      "a finished lease > #520: released, taken by another instance, then the old holder's finish: the new holder's lease is kept, and the key is not finished",
      "a finished lease > #520: a finish of a key nobody took finishes nothing: its first acquire takes it",
      "a finished lease > #520: a finished key stays finished for every instance, after any time, and a second finish changes nothing",
      "the framework's holder of a tree's lease > a holder frozen past the lease loses it to the waiting instance: its signal aborts",
      "the framework's holder of a tree's lease > a live holder renews every third of the lease: the waiting call waits",
      "the framework's holder of a tree's lease > a holder waiting for remote children keeps its tree: renewed, the waiting call waits, the holder goes on at leaseEpoch + 1",
      "the framework's holder of a tree's lease > a release wakes the waiting call at once, without the clock",
      "the framework's holder of a tree's lease > the caller's signal ends the wait with its reason",
      "the framework's holder at the lease's expiry > #534: fence.confirmNow() 1 ms before its expiry, its timers paused, is confirmed: the holder goes on",
      "the framework's holder at the lease's expiry > #534: fence.confirmNow() exactly at its expiry, its timers paused, is lost: the holder stops and the tree is taken over",
      "the framework's holder at the lease's expiry > #534: fence.confirmNow() 1 ms after its expiry, its timers paused, is lost: the holder stops and the tree is taken over",
      "the framework's holder at the lease's expiry > #534: the renewal before a checkpoint write 1 ms before its expiry, its timers paused, is confirmed: the holder goes on",
      "the framework's holder at the lease's expiry > #534: the renewal before a checkpoint write exactly at its expiry, its timers paused, is lost: the holder stops and the tree is taken over",
      "the framework's holder at the lease's expiry > #534: the renewal before a checkpoint write 1 ms after its expiry, its timers paused, is lost: the holder stops and the tree is taken over",
      "the framework's take of finished work > a stale instance's reclaim of a finished child's lease takes nothing and writes no takeover, also past the lease",
      "the framework's take of finished work > a take whose work ended while the store was asked gives the lease back at once and writes no takeover",
      "the framework's take of finished work > a take of work already over asks the store for nothing",
      "the framework's take of finished work > a take whose look at its work fails goes on as before: taken, and a takeover recorded",
      PING_CASE,
    ]);
  });
});
