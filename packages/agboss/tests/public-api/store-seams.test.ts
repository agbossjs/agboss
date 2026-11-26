/**
 * #1324: the pure rules a store outside the core shares are exported by `@agboss/core/stores`; the
 * SQLite transaction of a `runOnce` is `SqliteConnection.requireTransaction()` only, and the
 * checkpoint savers are not exported by the testing entries.
 */
import { describe, expect, it } from "vitest";
import * as faults from "../../src/testing/faults/index.js";
import * as stores from "../../src/stores/index.js";

describe("#1324: the store seams", () => {
  it("/stores exports the four rules and no free function for the SQLite transaction", () => {
    for (const name of ["transitionOf", "recordTransitionOf", "statusPageOf", "replacementPause"]) {
      expect(stores).toHaveProperty(name);
    }
    expect(stores).not.toHaveProperty("requireSqliteTransaction");
    expect(stores).not.toHaveProperty("SqliteCheckpointSaver");
  });

  it("/stores exports the three fence refusals and not the pause and stop classes behind them", () => {
    for (const name of ["cancelFencedOf", "pauseFencedOf", "stopFencedOf"]) {
      expect(stores).toHaveProperty(name);
    }
    expect(stores).not.toHaveProperty("ExecutionPauseFencedError");
    expect(stores).not.toHaveProperty("ExecutionStopFencedError");
  });

  it("/testing/faults exports no checkpoint saver", () => {
    expect(faults).not.toHaveProperty("SqliteCheckpointSaver");
  });

  it("recordTransitionOf takes an ExecutionRecordStatus as it takes a TurnStatus", () => {
    const thread = { tenantId: "t", threadId: "th" };
    const fromRecord = stores.recordTransitionOf(
      thread,
      stores.ExecutionRecordStatus.Paused,
      undefined,
      undefined,
    );
    const fromTurn = stores.recordTransitionOf(thread, "paused", undefined, undefined);
    expect(fromRecord).toEqual(fromTurn);
    expect(fromRecord).toMatchObject({ toStatus: "paused" });
    expect(
      stores.recordTransitionOf(thread, stores.ExecutionRecordStatus.Queued, undefined, undefined),
    ).toBeUndefined();
  });
});
