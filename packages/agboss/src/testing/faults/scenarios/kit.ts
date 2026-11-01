import { HoldPhase, type HoldRequest } from "../hold-points.js";
import type { PodEventFact } from "../facts.js";
import { stepPointOf, type FaultStepPoint } from "../fixture/pod-link.js";
import type { FaultPod } from "../pod.js";
import { FaultWorkflow, type FaultOrder } from "../pod-protocol.js";
import type { StoreHoldPoint } from "../store-points.js";
import type { FaultWorld } from "../world.js";

/**
 * What the scenarios are written with (#484): start an order and learn its tree, arm a hold and
 * wait for an operation to be held, release it, wait for a takeover or an end — every step of a
 * scenario waits on an event of the control channel, never on a sleep.
 */

/**
 * Records `message` as a failed expectation of the scenario unless `condition` holds: the run goes
 * on, and its invariants are checked first — a broken store is reported by the invariant it broke.
 */
export function expectThat(world: FaultWorld, condition: boolean, message: string): void {
  if (!condition) world.expectations.push(message);
}

/** A tree the scenario started: its order and its root execution. */
export interface StartedOrder {
  readonly orderId: string;
  readonly rootExecutionId: string;
  readonly tag: string;
}

/** Starts one order on `pod`; resolves once its first step ran (its root is known). */
export async function startOrder(
  world: FaultWorld,
  pod: FaultPod,
  orderId: string,
  options: Omit<FaultOrder, "orderId"> = {},
): Promise<StartedOrder> {
  const before = world.events.filter(
    (event) => event.type === "step" && event.orderId === orderId && event.point === "reserve",
  ).length;
  const tag = await world.start(pod, FaultWorkflow.Order, [
    { ...options, orderId, decline: options.decline ?? false },
  ]);
  const step = await world.stepOf(orderId, "reserve", before + 1);
  return { orderId, rootExecutionId: String(step.rootExecutionId), tag };
}

/** Arms a hold of the step `point` of `orderId` on `pod` (the next arrival). */
export const holdStep = (
  pod: FaultPod,
  point: FaultStepPoint,
  orderId?: string,
  times = 1,
): Promise<unknown> =>
  pod.command({
    op: "arm",
    request: {
      point: stepPointOf(point),
      times,
      ...(orderId === undefined ? {} : { key: orderId }),
    },
  });

/** Arms a hold of the store operation `point` on `pod`. */
export const holdStore = (
  pod: FaultPod,
  point: StoreHoldPoint,
  key: string | undefined,
  options: { readonly phase?: HoldPhase; readonly times?: number } = {},
): Promise<unknown> => {
  const request: HoldRequest = {
    point,
    phase: options.phase ?? HoldPhase.Before,
    times: options.times ?? 1,
    ...(key === undefined ? {} : { key }),
  };
  return pod.command({ op: "arm", request });
};

/** The `nth` operation held at `point` on `pod` (with `key`, when given). */
export const heldAt = (
  world: FaultWorld,
  pod: FaultPod,
  point: string,
  key?: string,
  nth = 1,
): Promise<PodEventFact> =>
  world.nth(
    `${point}${key === undefined ? "" : ` of ${key}`} held on ${pod.name}`,
    (event) =>
      event.type === "held" &&
      event.pod === pod.name &&
      event.point === point &&
      (key === undefined || event.key === key),
    nth,
  );

/** The step `point` of `orderId` held on `pod`. */
export const heldStep = (
  world: FaultWorld,
  pod: FaultPod,
  point: FaultStepPoint,
  orderId?: string,
): Promise<PodEventFact> => heldAt(world, pod, stepPointOf(point), orderId);

/** Lets a held operation go on. */
export const release = (pod: FaultPod, held: PodEventFact): Promise<unknown> =>
  pod.command({ op: "release", holdId: String(held.holdId) });

/** A takeover of `executionId`'s lease by `pod` (the `nth`, from 1). */
export const takenOverBy = (
  world: FaultWorld,
  pod: FaultPod,
  executionId: string,
): Promise<PodEventFact> =>
  world.next(
    `takeover of ${executionId} by ${pod.name}`,
    (event) =>
      event.type === "takeover" && event.pod === pod.name && event.leaseExecutionId === executionId,
  );

/** The execution `executionId` ended at a finish (not failed) on `pod`. */
export async function endedOn(
  world: FaultWorld,
  executionId: string,
  pod: FaultPod,
): Promise<void> {
  const end = await world.ended(executionId);
  expectThat(
    world,
    end.type === "end" && end.pod === pod.name,
    `${executionId} was to end on ${pod.name}; it ${end.type === "end" ? "ended" : "failed"} on ${end.pod}`,
  );
}

/** The step `point` of `orderId` on `pod` was stopped while held (its lease lost, its pod stopping). */
export const stoppedAt = (
  world: FaultWorld,
  pod: FaultPod,
  point: FaultStepPoint,
  orderId: string,
): Promise<PodEventFact> =>
  world.next(
    `${point} of ${orderId} stopped on ${pod.name}`,
    (event) =>
      event.type === "step-stopped" &&
      event.pod === pod.name &&
      event.point === point &&
      event.orderId === orderId,
  );

/** The events of `type` of `pod` (every pod when absent). */
export const eventsOf = (
  world: FaultWorld,
  type: string,
  pod?: FaultPod,
): readonly PodEventFact[] =>
  world.events.filter(
    (event) => event.type === type && (pod === undefined || event.pod === pod.name),
  );
