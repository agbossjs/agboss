import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import { systemClock } from "../../../infrastructure/clock.js";
import { seconds } from "../../../units/index.js";
import { FaultInvariant } from "../invariants/violations.js";
import { FaultPayment, FaultStoreSabotage } from "../pod-protocol.js";
import { StoreHoldPoint } from "../store-points.js";
import type { FaultSabotage } from "./sabotages.js";
import { endedOn, release, takenOverBy } from "./kit.js";
import { stuckOn, type StuckCall } from "./s22-kit.js";

/**
 * The sabotages of #928 (S2a, S2b), run on every store set: the framework's rule — a call whose
 * outcome is unknown is neither done nor not done — broken on purpose; each case passes only when
 * `effects-once` fails.
 * - S2a: the store never answers pod a's `markCompleted` (a hold is deaf, so the bound ends the
 *   call); the payment takes it for a definite failure: it sends again, never reconciles — the
 *   gateway charges twice. b takes the tree over.
 * - S2b: pod a's fenced-effect store answers `Ran` for the write that never answers, below the
 *   framework's bound (which therefore never fires), and the step goes on: the tree finishes past
 *   a charge nobody made.
 */

/** Pod a held for ever at `point`, its order made as `order`; b takes over, and a's hold goes at the end. */
async function takenOverStuck(cluster: FaultCluster, call: StuckCall): Promise<FaultPod> {
  const stuck = await stuckOn(cluster, call);
  await takenOverBy(cluster, stuck.b, stuck.key);
  await endedOn(cluster, stuck.key, stuck.b);
  await release(stuck.a, stuck.held);
  await Promise.race([stuck.a.exited, systemClock.sleep(seconds(1))]);
  return stuck.b;
}

export const s22UnknownAsNotSent: FaultSabotage = {
  id: "s22-sabotage-unknown-as-not-sent",
  title:
    "22 (S2a), sabotaged: a payment whose answer the store never took, taken for not sent — sent again, never reconciled",
  violates: FaultInvariant.EffectsOnce,
  evidence: /was paid 2 times at the gateway/u,
  run: (cluster) =>
    takenOverStuck(cluster, {
      point: StoreHoldPoint.OutboundMarkCompleted,
      orderId: "o-22s2a",
      order: { payment: FaultPayment.UnknownAsNotSent },
    }),
};

/**
 * S2b: a's fenced-effect store answers `Ran` for the charge's write that never answers, before the
 * framework's bound: a goes on and finishes the tree — its only charge is held, never written. The
 * hold stays: a late write would hide the missing row.
 */
export const s22UnknownAsDone: FaultSabotage = {
  id: "s22-sabotage-unknown-as-done",
  title:
    "22 (S2b), sabotaged: a charge whose fenced write the store never answered, taken for done — the step goes on writing",
  violates: FaultInvariant.EffectsOnce,
  evidence: /^o-22s2b \(\S+, finished\) has 0 business rows, not 1$/u,
  run: async (cluster) => {
    const stuck = await stuckOn(cluster, {
      point: StoreHoldPoint.FencedEffectWrite,
      orderId: "o-22s2b",
      sabotage: FaultStoreSabotage.TimeoutAsRan,
    });
    await endedOn(cluster, stuck.key, stuck.a);
    return stuck.a;
  },
};
