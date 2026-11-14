import { HoldPhase } from "../hold-points.js";
import type { FaultPod } from "../pod.js";
import type { FaultCluster } from "../cluster.js";
import type { RunnableFaultScenario } from "../scenario.js";
import { StoreHoldPoint } from "../store-points.js";
import { eventsOf, expectThat, release } from "./kit.js";
import {
  chargesOf,
  lateWriteRefused,
  statusesOf,
  stuckOn,
  takenOverAfterBound,
} from "./s22-kit.js";

/**
 * Scenarios 22a and 22b (#928): the store never answers the charge's fenced write. Pod a's call is
 * held for ever — a hold is deaf to the step's signal, as a silent peer is —, so the framework's
 * bound ends it: a stops at the end of its trust in the lease, gives nothing back (the lease
 * expires in the store) and hands the tree over; b takes it over at the expiry:
 * - 22a, the write held before the store is asked: it never ran — b's charge is `Ran`, once;
 * - 22b, held after the store committed it: b finds the row — `Replayed`, its `work` not called.
 * At the end a's hold is released: the late write is fenced (22a), no row.
 */
async function chargeNeverAnswered(
  cluster: FaultCluster,
  phase: HoldPhase,
  orderId: string,
  expected: string,
): Promise<FaultPod> {
  const point = StoreHoldPoint.FencedEffectWrite;
  const stuck = await stuckOn(cluster, { point, phase, orderId });
  await takenOverAfterBound(cluster, stuck);
  const { a, b } = stuck;
  expectThat(
    cluster,
    statusesOf(cluster, "charged", b) === expected,
    `b's charge was to be ${expected}; it was ${statusesOf(cluster, "charged", b)}`,
  );
  expectThat(cluster, eventsOf(cluster, "charged", a).length === 0, "a heard its charge answered");
  expectThat(
    cluster,
    chargesOf(cluster, orderId) === "b",
    `the gateway's charges of ${orderId} came from ${chargesOf(cluster, orderId)}, not b only`,
  );
  if (phase === HoldPhase.Before) await lateWriteRefused(cluster, stuck, point);
  else await release(a, stuck.held);
  return b;
}

export const s22aChargeNeverAnswers: RunnableFaultScenario = {
  id: "s22a-charge-never-answers",
  title:
    "22a: the store never answers the charge's fenced write — the holder stops at the end of its trust, the next holder charges once, the late write is fenced",
  run: (cluster) => chargeNeverAnswered(cluster, HoldPhase.Before, "o-22a", "ran"),
};

export const s22bChargeCommittedNeverAnswered: RunnableFaultScenario = {
  id: "s22b-charge-committed-never-answered",
  title:
    "22b: the charge committed and its answer never came — the next holder replays the row, its work not called",
  run: (cluster) => chargeNeverAnswered(cluster, HoldPhase.After, "o-22b", "replayed"),
};
