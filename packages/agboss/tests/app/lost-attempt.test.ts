/**
 * #860 D1 (recovery shard): the lost pass of a run no recovery continues, read from its tree's mark
 * before its keys go — one call of unknown cost under the run's own ledger key for a run that can
 * call a model, none for one that cannot or a tree with no mark, one for a mark of another shape
 * (fail closed) — and counted by the instance's tally under its workflow.
 */
import { describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app/app-deps.js";
import { lostRunLedgerIdOf, lostRunUsageOf, tallyLostRun } from "../../src/app/lost-attempt.js";
import { CostSource } from "../../src/finops/usage.js";
import { VirtualClock } from "../../src/testing/clock.js";

vi.mock("../../src/app/run-events.js", () => ({
  executionEventAt: () => ({ workflow: { name: "quote-workflow" } }),
}));

const NINE = new Date("2026-01-05T09:00:00.000Z");
const STATE = { runId: "run-1", threadId: "t-1", tenantId: "acme", startedVersion: "1" };

function partsWith(mark: unknown) {
  const findByIdInTree = vi.fn(() => Promise.resolve(mark));
  const parts = {
    deps: {} as AppDeps,
    trees: { findByIdInTree } as never,
    clock: new VirtualClock(NINE),
  };
  return { parts, findByIdInTree };
}

describe("#860 D1: a lost run's call of unknown cost", () => {
  it("a run that can call a model: one, no amount, under the run's ledger key, dated now", async () => {
    const { parts, findByIdInTree } = partsWith({ callsModel: true });

    const usage = await lostRunUsageOf(parts, STATE);

    expect(findByIdInTree).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "run-1" },
      "@agboss/without-recovery",
    );
    expect(usage).toEqual([
      expect.objectContaining({
        caller: "lost-pass:quote-workflow",
        model: "unknown",
        costUsd: 0,
        costSource: CostSource.Unknown,
        ledgerKey: { id: "unknown:lost-run:acme:run-1", madeAt: NINE },
      }),
    ]);
    expect(lostRunLedgerIdOf(STATE)).toBe("unknown:lost-run:acme:run-1");
  });

  it("a run that calls no model, or a tree no transport marked: none", async () => {
    expect(await lostRunUsageOf(partsWith({ callsModel: false }).parts, STATE)).toEqual([]);
    expect(await lostRunUsageOf(partsWith(undefined).parts, STATE)).toEqual([]);
  });

  it("a mark of another shape reads as a run that can: one (fail closed)", async () => {
    for (const mark of [true, null, "x", { callsModel: "no" }, {}])
      expect(await lostRunUsageOf(partsWith(mark).parts, STATE)).toHaveLength(1);
  });

  it("the tally counts them under the workflow; none counted for none, and none without a tally", async () => {
    const recorded = vi.fn();
    const deps = { observer: { unknownCosts: { recorded, unrecorded: vi.fn() } } } as never;
    const usage = await lostRunUsageOf(partsWith({ callsModel: true }).parts, STATE);

    tallyLostRun(deps, STATE, []);
    tallyLostRun(deps, STATE, usage);
    tallyLostRun({ observer: {} } as never, STATE, usage);

    expect(recorded.mock.calls).toEqual([["quote-workflow", 1]]);
  });
});
