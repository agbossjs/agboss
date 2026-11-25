import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/infrastructure/clock.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { HoldPhase } from "../../src/testing/faults/hold-points.js";
import { runFaultScenario } from "../../src/testing/faults/scenario.js";
import { heldAt, holdStore, release } from "../../src/testing/faults/scenarios/kit.js";
import { noticeMailboxOf } from "../../src/testing/faults/scenarios/pause-kit.js";
import { s28ReassignKill } from "../../src/testing/faults/scenarios/s28-pause-reassign.js";
import { StoreHoldPoint } from "../../src/testing/faults/store-points.js";
import { seconds } from "../../src/units/index.js";
import { sqliteFaultTarget } from "./sqlite-target.js";

/**
 * #1191 — a run waits for every pause its notice invariant checks, not only those a rest listed. The
 * replacement of a reassignment (scenario 28) is created while the tree rests: no pass lists it,
 * only the tree's record does, and its `closed` notice was once not waited for. A listener hears the move
 * itself as one `reassigned` of the replacement (#1307d), where it heard `opened` of it.
 */
describe("#1191: the run waits for a reassignment replacement's closed notice", () => {
  const DELAY = seconds(2);

  it("the replacement's closed notice held 2 s on pod b's delivery: the run waits and is green", async () => {
    const started = systemClock.now().getTime();
    let released: number | undefined;
    let replacementKey: string | undefined;
    let holdFailure: unknown;
    const delayed = {
      ...s28ReassignKill,
      run: (cluster: Parameters<typeof s28ReassignKill.run>[0]) => {
        void cluster
          .next(
            "the replacement sent",
            (e) => e.type === "pause-sent" && e.replacesKey !== undefined,
          )
          .then(async (sent) => {
            const newId = String(sent.pauseId);
            const key = pauseKeyOf("default", newId);
            replacementKey = key;
            // a listener hears a move to another channel as one `reassigned` of the replacement (#1307d)
            await cluster.next(
              "the replacement told reassigned",
              (e) => e.type === "pause-notice" && e.notice === "reassigned" && e.pauseKey === key,
            );
            const b = cluster.pods.find((pod) => pod.name === "b");
            if (b === undefined) throw new Error("no pod b");
            // the claim of the mailbox with the closed notice in it, held once it answered
            await holdStore(b, StoreHoldPoint.PauseNoticeClaim, noticeMailboxOf(newId), {
              phase: HoldPhase.After,
            });
            const held = await heldAt(
              cluster,
              b,
              StoreHoldPoint.PauseNoticeClaim,
              noticeMailboxOf(newId),
            );
            await systemClock.sleep(DELAY);
            released = systemClock.now().getTime();
            await release(b, held);
          })
          .catch((error: unknown) => {
            holdFailure = error;
          });
        return s28ReassignKill.run(cluster);
      },
    };

    const run = await runFaultScenario(delayed, sqliteFaultTarget());

    expect(holdFailure, String(holdFailure)).toBeUndefined();
    expect(released, "the hold was released").toBeDefined();
    const closed = run.events.filter(
      (event) =>
        event.type === "pause-notice" &&
        event.notice === "closed" &&
        event.pauseKey === replacementKey,
    );
    expect(closed.length).toBeGreaterThan(0);
    expect(systemClock.now().getTime() - started).toBeGreaterThanOrEqual(DELAY);
  }, 240_000);
});
