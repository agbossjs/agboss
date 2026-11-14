import type { FaultCluster } from "../cluster.js";
import { HoldPhase } from "../hold-points.js";
import { OperationPhase } from "../operation-history.js";
import type { FaultPod } from "../pod.js";
import type { PodEventFact } from "../facts.js";
import type { FaultStoreSabotage } from "../pod-protocol.js";
import type { FaultOrder } from "../pod-protocol.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  endedOn,
  eventsOf,
  expectThat,
  heldAt,
  holdStore,
  release,
  startOrder,
  takenOverBy,
} from "./kit.js";

/**
 * The helpers of the #928 scenarios (s22): an order on pod a whose store call at `point` is held
 * for ever — the store never answers, and a hold is deaf to the step's signal, as a silent peer
 * is. Pod a ends the call at the bound of its trust in the lease and hands the tree over; pod b
 * takes it over once the lease expired in the store and finishes it.
 */

/** A tree whose call at a point is held on `a` for ever, and the pods that move it. */
export interface Stuck {
  readonly a: FaultPod;
  readonly b: FaultPod;
  readonly key: string;
  readonly held: PodEventFact;
}

/** What a stuck call is: where it is held, in which phase, and how its order is made. */
export interface StuckCall {
  readonly point: StoreHoldPoint;
  readonly phase?: HoldPhase;
  readonly orderId: string;
  readonly order?: Omit<FaultOrder, "orderId">;
  /** Pod a's store broken on purpose. */
  readonly sabotage?: FaultStoreSabotage;
}

/** Pod a held at the call, never released: the order started, the hold reached. */
export async function stuckOn(cluster: FaultCluster, call: StuckCall): Promise<Stuck> {
  const a = await cluster.pod("a", call.sabotage === undefined ? {} : { sabotage: call.sabotage });
  const b = await cluster.pod("b");
  await holdStore(a, call.point, undefined, { phase: call.phase ?? HoldPhase.Before });
  const key = (await startOrder(cluster, a, call.orderId, call.order)).rootExecutionId;
  const held = await heldAt(cluster, a, call.point, key);
  // a's own sweep must not take the expired tree back before b's: its takes of it are held (as in 4)
  await holdStore(a, StoreHoldPoint.LeaseAcquire, key, { times: 1000 });
  return { a, b, key, held };
}

/** Pod a's hand-over (its call ended at the bound), b's takeover at the lease's expiry, b's end. */
export async function takenOverAfterBound(cluster: FaultCluster, stuck: Stuck): Promise<void> {
  const { a, b, key } = stuck;
  await cluster.next(
    `a's hand-over of ${key}`,
    (event) => event.type === "handed-over" && event.pod === a.name,
  );
  await takenOverBy(cluster, b, key);
  await endedOn(cluster, key, b);
  expectThat(
    cluster,
    a.output.includes("store.call-timeout"),
    "a's log has no store.call-timeout: its call was not ended by the bound",
  );
}

/** How `pod`'s call at `point` of `key` ended, from the history: its error's name, or `accepted`. */
export function callEnd(
  cluster: FaultCluster,
  pod: FaultPod,
  point: StoreHoldPoint,
  key: string,
): string | undefined {
  const complete = cluster.history.events.find(
    (event) =>
      event.phase === OperationPhase.Complete &&
      event.process === pod.name &&
      event.operation === point &&
      event.key === key,
  );
  if (complete === undefined) return undefined;
  return complete.error?.name ?? "accepted";
}

/** Lets a's held call go on at the end: its late write is refused, whatever it was. */
export async function lateWriteRefused(
  cluster: FaultCluster,
  stuck: Stuck,
  point: StoreHoldPoint,
): Promise<void> {
  await release(stuck.a, stuck.held);
  await cluster.until(
    `the answer to a's late ${point}`,
    () => callEnd(cluster, stuck.a, point, stuck.key) !== undefined,
  );
  const end = callEnd(cluster, stuck.a, point, stuck.key);
  expectThat(
    cluster,
    end === "ExecutionFencedError",
    `a's late ${point} was to be refused (ExecutionFencedError); it was ${String(end)}`,
  );
}

/** The gateway's charges of the order, with whom they came from. */
export const chargesOf = (cluster: FaultCluster, orderId: string): string =>
  cluster.gateway.requests
    .filter((request) => request.orderId === orderId)
    .map((request) => request.pod)
    .join();

/** What `pod` told of the order's charge or payment: the status of each `type` event. */
export const statusesOf = (cluster: FaultCluster, type: string, pod: FaultPod): string =>
  eventsOf(cluster, type, pod)
    .map((event) => String(event.status))
    .join();
