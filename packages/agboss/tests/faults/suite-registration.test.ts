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
import { SABOTAGES, type FaultSabotage } from "../../src/testing/faults/scenarios/sabotages.js";
import {
  runContractFixtures,
  type FixtureCase,
  type FixtureRun,
} from "../testing/contracts/fixture-runs.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

let run: FixtureRun;

beforeAll(async () => {
  run = await runContractFixtures(["fault-suite-skips.contract-fixture.ts"]);
}, 300_000);

const casesOf = (suite: string): readonly FixtureCase[] =>
  run.cases.filter((found) => found.suites[0] === suite);

const TOTAL = SCENARIOS.length + SABOTAGES.length;

describe("#831 AC2: the suite shows what it leaves out", () => {
  it("one shard of a selection: the count first, the atomic case, then every scenario skipped with its reason", () => {
    const cases = casesOf("fault suite (SQLite)");

    expect(cases.map((found) => found.name).slice(0, 2)).toEqual([
      `runs 0 of ${String(TOTAL)} cases: 0 of ${String(SCENARIOS.length)} scenarios, 0 of 2 sabotages (selected by scenarios:, shard 2/2)`,
      ATOMIC_FENCING_CASE,
    ]);
    expect(cases.slice(0, 2).map((found) => found.state)).toEqual(["pass", "pass"]);
    const rest = cases.slice(2);
    expect(rest).toHaveLength(TOTAL);
    expect(rest.every((found) => found.state === "skip")).toBe(true);
    expect(rest.find((found) => found.name === SCENARIOS[0]?.title)?.note).toBe(
      "in another shard than 2/2",
    );
    expect(rest.find((found) => found.name === SCENARIOS[1]?.title)?.note).toBe(
      "not selected: scenarios: names others",
    );
    expect(
      rest.filter((found) => found.name.startsWith("sabotage ")).map((found) => found.name),
    ).toEqual(SABOTAGES.map((one) => `sabotage ${one.title}: fails effects-once`));
  });

  it("sabotages: false: a selected sabotage is skipped, saying so", () => {
    const sabotage = casesOf("fault suite (SQLite, no sabotages)").find(
      (found) => found.name === `sabotage ${SABOTAGES[0]?.title ?? ""}: fails effects-once`,
    );

    expect(sabotage?.state).toBe("skip");
    expect(sabotage?.note).toMatch(/^sabotages: false — /u);
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
