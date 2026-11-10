/**
 * #831 AC2 — `faultSuite` registers every case it does not run as a skipped one, with the reason,
 * and counts what it runs in its first case (fault-suite-skips.contract-fixture.ts, in a vitest of
 * its own); a sabotage's case passes only when the sabotage fails its invariant.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sabotaged } from "../../src/testing/faults/fault-suite.js";
import { FaultInvariant } from "../../src/testing/faults/index.js";
import { ATOMIC_FENCING_CASE } from "../../src/testing/faults/opt-out-check.js";
import { SCENARIOS } from "../../src/testing/faults/scenarios/index.js";
import { NO_A2A_TASKS } from "../../src/testing/faults/scenarios/a2a-kit.js";
import { SABOTAGES, type FaultSabotage } from "../../src/testing/faults/scenarios/sabotages.js";
import {
  runContractFixtures,
  type FixtureCase,
  type FixtureRun,
} from "../testing/contracts/fixture-runs.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures([
    "fault-suite-skips.contract-fixture.ts",
    "fault-suite-no-a2a.contract-fixture.ts",
  ]);
}, 300_000);

const casesOf = (suite: string): readonly FixtureCase[] =>
  run.cases.filter((found) => found.suites[0] === suite);

const TOTAL = SCENARIOS.length + SABOTAGES.length;

describe("#831 AC2: the suite shows what it leaves out", () => {
  it("the count first, the atomic case, then every case — run, or skipped with its reason", () => {
    const cases = casesOf("fault suite (SQLite)");
    const titleOf = (id: string): string | undefined =>
      SCENARIOS.find((scenario) => scenario.id === id)?.title;
    const of = (id: string): FixtureCase | undefined =>
      cases.find((found) => found.name === titleOf(id));

    expect(cases.map((found) => found.name).slice(0, 2)).toEqual([
      `runs 1 of ${String(TOTAL)} cases: 1 of ${String(SCENARIOS.length)} scenarios, 0 of 2 sabotages (selected by scenarios:, shard 2/2, sabotages: false)`,
      ATOMIC_FENCING_CASE,
    ]);
    expect(cases.slice(0, 2).map((found) => found.state)).toEqual(["pass", "pass"]);
    expect(cases.slice(2)).toHaveLength(TOTAL);
    expect(of("s02-sigkill-mid-step")?.state).toBe("pass");
    expect(of("s01-sigterm-drains")).toMatchObject({
      state: "skip",
      note: "in another shard than 2/2",
    });
    expect(of("s03-crash-after-charge")).toMatchObject({
      state: "skip",
      note: "not selected: scenarios: names others",
    });
    const sabotages = cases.filter((found) => found.name.startsWith("sabotage "));
    expect(sabotages.map((found) => found.name)).toEqual(
      SABOTAGES.map((one) => `sabotage ${one.title}: fails effects-once`),
    );
    expect(sabotages[0]?.note).toMatch(/^sabotages: false — /u);
    expect(cases.filter((found) => found.state === "skip")).toHaveLength(TOTAL - 1);
  });
});

describe("#811 AC4: a store set that keeps no A2A tasks", () => {
  it("skips every A2A scenario with the reason — none passed, none failed", () => {
    const cases = casesOf("fault suite (SQLite, no A2A tasks)");
    const a2a = SCENARIOS.filter((scenario) => /^s1[78]/u.test(scenario.id));
    const of = a2a.map((scenario) => cases.find((found) => found.name === scenario.title));

    expect(a2a).toHaveLength(5);
    expect(of.map((found) => ({ state: found?.state, note: found?.note }))).toEqual(
      a2a.map(() => ({ state: "skip", note: NO_A2A_TASKS })),
    );
    expect(cases.filter((found) => found.state === "fail")).toEqual([]);
  });
});

describe("#831 AC2: a sabotage's case passes only when the sabotage breaks its invariant", () => {
  it("a sabotage that charges twice: its case passes", async () => {
    const [first] = SABOTAGES;
    if (first === undefined) throw new Error("no sabotage");

    await expect(sabotaged(first, sqliteFaultTarget(), expect)).resolves.toBeUndefined();
  }, 240_000);

  it("a 'sabotage' that breaks nothing: its case fails — the suite would not bite", async () => {
    const harmless: FaultSabotage = {
      id: "s00-harmless",
      title: "one pod, nothing ordered",
      run: (cluster) => cluster.pod("a"),
      violates: FaultInvariant.EffectsOnce,
      evidence: /was paid 2 times/u,
    };

    await expect(sabotaged(harmless, sqliteFaultTarget(), expect)).rejects.toThrow(
      /s00-harmless: the sabotage passed — the suite does not bite/u,
    );
  }, 120_000);
});
