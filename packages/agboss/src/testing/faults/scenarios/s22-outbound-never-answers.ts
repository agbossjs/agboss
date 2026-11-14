import { HoldPhase } from "../hold-points.js";
import type { FaultCluster } from "../cluster.js";
import type { FaultPod } from "../pod.js";
import { FaultPayment } from "../pod-protocol.js";
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
 * Scenarios 22c, 22d and 22e (#928): the store never answers a write of the payment's outbound
 * call — the intent (`saveIfAbsent`), the answer (`markCompleted`), a definite failure
 * (`markFailed`). Pod a's call is held for ever; the bound ends it, a hands the tree over at the
 * end of its trust and gives nothing back; b takes it over at the lease's expiry and reads the row:
 * - 22c, `markCompleted` held before the store: the gateway charged once, the row is `Pending` —
 *   a logs `outbound-call.answer-unrecorded`, b reconciles with the gateway (`Reconciled`);
 *   22c2, held after: the row is `Completed` — b `Replayed`;
 * - 22d, `saveIfAbsent` held before: no row — b records the intent and sends (`Sent`, once);
 *   22d2, held after: the intent is there, unsent — b reconciles, finds nothing sent, sends once;
 * - 22e, `markFailed` held: the gateway refused (nothing charged), the row stays `Pending` — b
 *   reconciles before any resend and charges at most once.
 * At the end a's hold is released: a late write before the store is fenced.
 */

/** The scenario of the outbound call's `point` held in `phase`: what b's payment is, how many charges, who made them. */
async function outboundNeverAnswered(
  cluster: FaultCluster,
  options: {
    readonly point: StoreHoldPoint;
    readonly phase: HoldPhase;
    readonly orderId: string;
    readonly paid: string;
    readonly refused?: boolean;
  },
): Promise<FaultPod> {
  const { point, phase, orderId, paid } = options;
  if (options.refused === true) cluster.gateway.refuseNext(orderId);
  const stuck = await stuckOn(cluster, {
    point,
    phase,
    orderId,
    order: { payment: FaultPayment.Lookup },
  });
  await takenOverAfterBound(cluster, stuck);
  const { a, b } = stuck;
  expectThat(
    cluster,
    statusesOf(cluster, "paid", b) === paid,
    `b's payment was to be ${paid}; it was ${statusesOf(cluster, "paid", b) || "none"}`,
  );
  if (point === StoreHoldPoint.OutboundMarkCompleted && phase === HoldPhase.Before)
    expectThat(
      cluster,
      a.output.includes("outbound-call.answer-unrecorded"),
      "a's log has no outbound-call.answer-unrecorded",
    );
  expectThat(cluster, eventsOf(cluster, "paid", a).length === 0, "a heard its payment answered");
  const charges = chargesOf(cluster, orderId);
  expectThat(
    cluster,
    charges.split(",").length === 1 && charges !== "",
    `charges of ${orderId}: ${charges || "none"}`,
  );
  if (phase === HoldPhase.Before) await lateWriteRefused(cluster, stuck, point);
  else await release(a, stuck.held);
  return b;
}

export const s22cPaymentAnswerNeverRecorded: RunnableFaultScenario = {
  id: "s22c-payment-answer-never-recorded",
  title:
    "22c: the gateway charged and the store never took the answer — one charge, the next holder reconciles the pending call",
  run: (cluster) =>
    outboundNeverAnswered(cluster, {
      point: StoreHoldPoint.OutboundMarkCompleted,
      phase: HoldPhase.Before,
      orderId: "o-22c",
      paid: "reconciled",
    }),
};

export const s22c2AnswerRecordedNeverAnswered: RunnableFaultScenario = {
  id: "s22c2-payment-answer-recorded-never-answered",
  title:
    "22c2: the store recorded the gateway's answer and never said so — the next holder replays it, nothing resent",
  run: (cluster) =>
    outboundNeverAnswered(cluster, {
      point: StoreHoldPoint.OutboundMarkCompleted,
      phase: HoldPhase.After,
      orderId: "o-22c2",
      paid: "replayed",
    }),
};

export const s22dIntentNeverAnswered: RunnableFaultScenario = {
  id: "s22d-intent-never-answered",
  title:
    "22d: the store never answers the payment's intent — nothing recorded, nothing sent; the next holder records and sends once",
  run: (cluster) =>
    outboundNeverAnswered(cluster, {
      point: StoreHoldPoint.OutboundSaveIfAbsent,
      phase: HoldPhase.Before,
      orderId: "o-22d",
      paid: "sent",
    }),
};

export const s22d2IntentRecordedNeverAnswered: RunnableFaultScenario = {
  id: "s22d2-intent-recorded-never-answered",
  title:
    "22d2: the intent was recorded and its answer never came — the next holder reconciles it, finds nothing sent, sends once",
  run: (cluster) =>
    outboundNeverAnswered(cluster, {
      point: StoreHoldPoint.OutboundSaveIfAbsent,
      phase: HoldPhase.After,
      orderId: "o-22d2",
      paid: "sent",
    }),
};

export const s22eFailureNeverRecorded: RunnableFaultScenario = {
  id: "s22e-failure-never-recorded",
  title:
    "22e: a definite failure whose record the store never answers — the row stays pending, the next holder reconciles before any resend",
  run: (cluster) =>
    outboundNeverAnswered(cluster, {
      point: StoreHoldPoint.OutboundMarkFailed,
      phase: HoldPhase.Before,
      orderId: "o-22e",
      paid: "sent",
      refused: true,
    }),
};
