import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FaultInvariant, FaultInvariantError } from "../../src/testing/faults/index.js";
import { HoldPhase } from "../../src/testing/faults/hold-points.js";
import { runFaultScenario } from "../../src/testing/faults/scenario.js";
import { s25Dropped, runDropped } from "../../src/testing/faults/scenarios/s25-cancel-resting.js";
import { heldAt, holdStore, release } from "../../src/testing/faults/scenarios/kit.js";
import { noticeMailboxOf } from "../../src/testing/faults/scenarios/pause-kit.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { systemClock } from "../../src/infrastructure/clock.js";
import { seconds } from "../../src/units/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1178 — a run waits for the notices its invariant checks. Scenario 25's tree ends `failed` (a
 * cancel), not with an `end` event: the run's settle once looked only for `end`, found nothing to
 * wait for, and read the facts while the `closed` notice was still on its way.
 */
describe("#1178: the run waits for a failed tree's closed notice", () => {
  const DELAY = seconds(2);

  it("a closed notice held 2 s on its delivery: the run waits for it and is green", async () => {
    const started = systemClock.now().getTime();
    let released: number | undefined;
    const delayed = {
      ...s25Dropped,
      run: (cluster: Parameters<typeof runDropped>[0]) =>
        runDropped(cluster, async (a, order) => {
          const mailbox = noticeMailboxOf(order.pauseId);
          await cluster.nth(
            "the pause told opened",
            (event) => event.type === "pause-notice" && event.notice === "opened",
            1,
          );
          // the claim of the mailbox with the closed notice in it, held once it answered
          await holdStore(a, StoreHoldPoint.PauseNoticeClaim, mailbox, { phase: HoldPhase.After });
          void heldAt(cluster, a, StoreHoldPoint.PauseNoticeClaim, mailbox).then(async (held) => {
            await systemClock.sleep(DELAY);
            released = systemClock.now().getTime();
            await release(a, held);
          });
        }),
    };

    const run = await runFaultScenario(delayed, sqliteFaultTarget());

    const closed = run.events.filter(
      (event) => event.type === "pause-notice" && event.notice === "closed",
    );
    expect(closed.length).toBeGreaterThan(0);
    expect(released, "the hold was released").toBeDefined();
    expect(systemClock.now().getTime() - started).toBeGreaterThanOrEqual(DELAY);
  }, 120_000);

  it("a pause store that never delivers a closed notice: red, the pause never told closed", async () => {
    const target = sqliteFaultTarget(
      fileURLToPath(new URL("./never-closed.fault-stores.ts", import.meta.url)),
    );

    const failure: unknown = await runFaultScenario(s25Dropped, target).catch(
      (error: unknown) => error,
    );

    expect(failure, String(failure)).toBeInstanceOf(FaultInvariantError);
    const { violations } = failure as FaultInvariantError;
    expect(violations.map((one) => one.invariant)).toContain(FaultInvariant.NoticesOnceEachInOrder);
    expect(violations.map((one) => one.message)).toContainEqual(
      expect.stringMatching(/was never told closed/u),
    );
  }, 120_000);
});
