import { Clock, systemClock } from "../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import { FakeOutboundGateway } from "../gateway/fake-outbound-gateway.js";
import type { GatewayPaymentFact, GatewayRequest } from "./facts.js";
import type { FaultPod } from "./pod.js";
import type { GatewayCall } from "./pod-protocol.js";

/**
 * The payment gateway of a fault run (#484): one `FakeOutboundGateway` in the test's process,
 * every capability on (G1–G5), called by the pods over their control channels. Every charge that
 * reaches it is kept (`requests`), every payment it made (`payments`). `holdAnswer(orderId)`
 * makes it process the next charge of that order and keep its answer back — the pod waits, its
 * request made — until `releaseAnswers()`: a pod killed meanwhile crashed after sending, before
 * the answer (scenario 9). `dropAnswer(orderId)` makes it process the next charge of that order and
 * answer it with an error (#657: a 5xx after the charge — scenario 14); `forgetKeys()` moves its own
 * time past its keys' retention (#657, #658: the key expired — scenarios 14 and 15). Its lookup
 * reads its books by the order's reference, which never expire, not its keys.
 */

/** The answer of a charge whose answer was lost after the gateway processed it. */
export const DROPPED_ANSWER = "the gateway's answer was lost after it charged (502 Bad Gateway)";

/** The gateway's own time: the real time, moved ahead by `pass` (its keys age, nobody else's). */
class GatewayClock extends Clock {
  #ahead = 0;

  now(): Date {
    return new Date(systemClock.now().getTime() + this.#ahead);
  }

  sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    return systemClock.sleep(delay, signal);
  }

  pass(duration: Milliseconds): void {
    this.#ahead += duration;
  }
}

/** An answer held back, and the pod waiting for it. */
interface HeldAnswer {
  readonly pod: FaultPod;
  readonly id: number;
  readonly answer: { readonly result?: unknown; readonly error?: string };
}

export class FaultGateway {
  readonly requests: GatewayRequest[] = [];
  readonly #clock = new GatewayClock();
  readonly #gateway = new FakeOutboundGateway({ clock: this.#clock });
  readonly #holds = new Set<string>();
  readonly #drops = new Set<string>();
  readonly #held: HeldAnswer[] = [];
  readonly #onHeld = new Set<(orderId: string) => void>();

  /** Every payment the gateway made, in order. */
  get payments(): readonly GatewayPaymentFact[] {
    return this.#gateway.payments.map(({ paymentId, idempotencyKey }) => ({
      paymentId,
      idempotencyKey,
    }));
  }

  /** The next charge of `orderId` is made, and answered with an error (#657): `DROPPED_ANSWER`. */
  dropAnswer(orderId: string): void {
    this.#drops.add(orderId);
  }

  /** Its time moves past its keys' retention: a repeat of any key it saw is a new payment. */
  forgetKeys(): void {
    this.#clock.pass((this.#gateway.capabilities.keyRetention + seconds(1)) as Milliseconds);
  }

  /** The next charge of `orderId` is made, and its answer kept back until `releaseAnswers()`. */
  holdAnswer(orderId: string): void {
    this.#holds.add(orderId);
  }

  /** Resolves once a charge of `orderId` was made and its answer held. */
  answerHeld(orderId: string): Promise<void> {
    return new Promise((resolve) => {
      const heard = (held: string): void => {
        if (held !== orderId) return;
        this.#onHeld.delete(heard);
        resolve();
      };
      this.#onHeld.add(heard);
    });
  }

  /** Sends every held answer (to pods still running: a dead one gets nothing). */
  releaseAnswers(): void {
    for (const held of this.#held.splice(0)) held.pod.answerGateway(held.id, held.answer);
  }

  /** A pod's call: a charge (kept, maybe held) or a lookup by its idempotency key. */
  async call(pod: FaultPod, id: number, call: GatewayCall): Promise<void> {
    const answer = await this.#answerOf(pod, call);
    if (call.op === "charge" && this.#holds.delete(call.orderId)) {
      this.#held.push({ pod, id, answer });
      for (const heard of [...this.#onHeld]) heard(call.orderId);
      return;
    }
    pod.answerGateway(id, answer);
  }

  async #answerOf(
    pod: FaultPod,
    call: GatewayCall,
  ): Promise<{ readonly result?: unknown; readonly error?: string }> {
    const { idempotencyKey, orderId, amount } = call;
    try {
      // by the order's reference: its books, kept whatever its keys' retention
      if (call.op === "lookup") return { result: this.#byReference(idempotencyKey) ?? null };
      this.requests.push({ pod: pod.name, idempotencyKey, orderId });
      const receipt = await this.#gateway.charge({ idempotencyKey, amount });
      if (this.#drops.delete(orderId)) return { error: DROPPED_ANSWER };
      return { result: receipt };
    } catch (error) {
      return { error: String(error) };
    }
  }

  /** The first payment made under `idempotencyKey`, from the books. */
  #byReference(idempotencyKey: string): { readonly paymentId: string } | undefined {
    const found = this.#gateway.payments.find(
      (payment) => payment.idempotencyKey === idempotencyKey,
    );
    return found === undefined ? undefined : { paymentId: found.paymentId };
  }
}
