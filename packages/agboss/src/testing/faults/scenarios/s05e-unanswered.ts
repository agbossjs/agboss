import { systemClock } from "../../../infrastructure/clock.js";
import { FaultInvariant } from "../invariants/violations.js";
import { FaultStoreSabotage } from "../pod-protocol.js";
import { StoreHoldPoint } from "../store-points.js";
import type { FaultSabotage } from "./sabotages.js";
import { expectThat, heldAt, holdStore, release, startOrder, takenOverBy } from "./kit.js";

/**
 * Scenario 5e (#876, #959): 5b's zombie on a set whose fenced-effect store lets a stale token
 * through at the lease's current epoch (`FaultStoreSabotage.StaleThenKilled`, built from the
 * set's own store) and kills its pod before the answer. The history holds the write's invoke and
 * no answer; the store's row keeps the write at the epoch it was let through at; the new holder's
 * write finds the key there and replays it — which wrote nothing, so it explains no row. Only
 * `one-owner`, reading the store's rows, tells the stale write.
 *
 * Run on every store set, a sabotage like 14 and 15 (#831): its case passes only when `one-owner`
 * fails with the unanswered write as its evidence. The barrier is the zombie's exit, never the
 * release's ack: on an async store the ack comes back before the write runs.
 */
export const s05eZombieDiesUnanswered: FaultSabotage = {
  id: "s05e-zombie-dies-unanswered",
  title:
    "5e: the zombie's stale charge is let through and its pod dies before the answer — the new holder replays it",
  violates: FaultInvariant.OneOwner,
  evidence:
    /^fencedEffect\.write of \S+ at token 1 \(\S+\) was accepted after epoch 2 was granted to \S+: a stale write \(never answered: its pod died before the answer, and the store's row holds the write at token 2\)$/u,
  run: async (cluster) => {
    const point = StoreHoldPoint.FencedEffectWrite;
    const a = await cluster.pod("a", { sabotage: FaultStoreSabotage.StaleThenKilled });
    const b = await cluster.pod("b");
    await holdStore(a, point, undefined);
    await holdStore(b, point, undefined);
    const key = (await startOrder(cluster, a, "o-5e")).rootExecutionId;
    const frozen = await heldAt(cluster, a, point, key);
    a.freeze();
    await takenOverBy(cluster, b, key);
    const second = await heldAt(cluster, b, point, key);
    a.thaw();
    // the ack may come back or die with the pod; a's exit is what the store's kill makes
    await release(a, frozen).catch(() => undefined);
    await Promise.race([a.exited, systemClock.sleep(cluster.waitTimeout)]);
    expectThat(cluster, !a.isRunning, "a's stale write was to kill a before its answer; a runs");
    await release(b, second);
    await cluster.ended(key);
    return b;
  },
};
