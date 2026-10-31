import { Injectable } from "../../../components/decorators.js";
import { HoldPhase, processHoldPoints } from "../hold-points.js";
import type { FromPod, GatewayCall, PodEvent } from "../pod-protocol.js";

/**
 * A fault pod's side of its control channel, as the fixture application's components use it
 * (#484): `emit` tells the test what happened, `atStep` is a step's hold point (`step.<name>`,
 * keyed by the order: `beforeCharge` is `step.charge.before`), `gateway` calls the test's payment
 * gateway and waits for its answer — which the test may hold. The channel is the process's own:
 * the pod's main connects it to `process.send`, an in-process test to an array.
 */

/** Where a pod's messages go. */
export interface PodPort {
  send(message: FromPod): void;
}

/** The port of this process, and the gateway calls waiting for their answer. */
const link: {
  port: PodPort | undefined;
  calls: number;
  readonly waiting: Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >;
} = { port: undefined, calls: 0, waiting: new Map() };

/** Connects this process's link to `port` (the pod's main: `process.send`). */
export function connectPodLink(port: PodPort | undefined): void {
  link.port = port;
}

/** Sends `message` when the link is connected; a process with none sends nothing. */
export function sendToTest(message: FromPod): void {
  link.port?.send(message);
}

/** Delivers the test's answer to the gateway call `id`. */
export function deliverGatewayReply(id: number, result: unknown, error: string | undefined): void {
  const waiting = link.waiting.get(id);
  if (waiting === undefined) return;
  link.waiting.delete(id);
  if (error === undefined) waiting.resolve(result);
  else waiting.reject(new Error(error));
}

/** The steps of the fixture with hold points: `step.<point>`, keyed by the order's id. */
export enum FaultStepPoint {
  Reserve = "reserve",
  ChargeBefore = "charge.before",
  /** The charge is written and committed, the step's checkpoint not yet: a crash here repeats it. */
  ChargeAfter = "charge.after",
  PayBefore = "pay.before",
  PayAfter = "pay.after",
  Release = "release",
}

/** The hold point's name of a step's point. */
export const stepPointOf = (point: FaultStepPoint): string => `step.${point}`;

@Injectable()
export class FaultPodLink {
  /** Tells the test what happened. */
  emit(type: string, fields: Readonly<Record<string, unknown>> = {}): void {
    const event: PodEvent = { ...fields, type };
    sendToTest({ kind: "event", event });
  }

  /** A step at its point: told to the test, then held while a hold of the test matches. */
  async atStep(
    point: FaultStepPoint,
    fields: Readonly<Record<string, unknown>> & { readonly orderId: string },
    signal: AbortSignal,
  ): Promise<void> {
    this.emit("step", { ...fields, point });
    try {
      await processHoldPoints.reach(stepPointOf(point), HoldPhase.Before, fields.orderId, signal);
    } catch (error) {
      // held, then stopped: its lease was lost or its instance stops — it hands over
      this.emit("step-stopped", { ...fields, point, reason: String(error) });
      throw error;
    }
  }

  /** Calls the test's payment gateway; the answer comes when the test sends it. */
  gateway(call: GatewayCall, signal: AbortSignal): Promise<unknown> {
    link.calls += 1;
    const id = link.calls;
    return new Promise<unknown>((resolve, reject) => {
      link.waiting.set(id, { resolve, reject });
      signal.addEventListener(
        "abort",
        () => {
          link.waiting.delete(id);
          reject(signal.reason instanceof Error ? signal.reason : new Error("the call stopped"));
        },
        { once: true },
      );
      sendToTest({ kind: "gateway", id, call });
    });
  }
}
