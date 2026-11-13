/**
 * #971 AC1 — scenario 6b reads the answer to the held, frozen lease ask (not pod a's earlier one):
 * a finish that is a plain release, built from the set's own store (`FaultStoreSabotage.RetireReleases`,
 * run by every set's suite), hands the finished child's lease to that ask, and the scenario's own
 * check says so, besides `finished-work-untouched`.
 */
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError } from "../../src/testing/faults/index.js";
import { sabotaged } from "../../src/testing/faults/fault-suite.js";
import { runFaultScenario } from "../../src/testing/faults/scenario.js";
import { s06cFinishedGranted } from "../../src/testing/faults/scenarios/s06-children.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

describe("#971 AC1: 6b's check reads the held ask's answer", () => {
  it("a lease store whose finish is a plain release: the held ask is granted the lease — its note, and finished-work-untouched", async () => {
    const error: unknown = await runFaultScenario(s06cFinishedGranted, sqliteFaultTarget()).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error, String(error)).toBeInstanceOf(FaultInvariantError);
    if (!(error instanceof FaultInvariantError)) return;
    expect(error.invariants).toContain(FaultInvariant.FinishedWorkUntouched);
    expect(error.notes).toContainEqual(
      expect.stringMatching(/^a's held ask for the finished child got \{.*"token":\d+/u),
    );
  }, 120_000);

  it("as the suite runs it on every set: the case passes on its invariant and evidence", async () => {
    await expect(
      sabotaged(s06cFinishedGranted, sqliteFaultTarget(), expect),
    ).resolves.toBeUndefined();
  }, 120_000);
});
