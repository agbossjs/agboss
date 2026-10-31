import type { Clock } from "../../infrastructure/clock.js";
import { hours, seconds, type Milliseconds } from "../../units/index.js";

/**
 * A payment gateway in the test's process (#508): what a team's adapter is checked against offline
 * (`outboundGatewayChecklist`), each capability of the Wiki's Payment-gateways page a switch, and
 * the faults that make an outbound call's outcome unknown. Time is the given `Clock` (a test's
 * `VirtualClock`): a key's retention and a slow answer move only with it.
 */

/** What the gateway supports — the requirements G1–G5 of Payment-gateways, each on or off. */
export interface FakeGatewayCapabilities {
  /** G1: a client idempotency key deduplicates a repeat. */
  readonly idempotencyKeys: boolean;
  /** G3: how long a key is kept; a repeat after it is a new payment. */
  readonly keyRetention: Milliseconds;
  /** G2: a payment is found by the key it was made with. */
  readonly lookupByKey: boolean;
  /** G4: a repeat gets the first response, not a fresh one. */
  readonly firstResponseOnRepeat: boolean;
  /** G5: the same key with other parameters is refused. */
  readonly conflictOnMismatch: boolean;
}

/** Every capability on, keys kept for a day. */
export const FULL_GATEWAY_CAPABILITIES: FakeGatewayCapabilities = Object.freeze({
  idempotencyKeys: true,
  keyRetention: hours(24),
  lookupByKey: true,
  firstResponseOnRepeat: true,
  conflictOnMismatch: true,
});

/** What can go wrong with the next charge. */
export enum FakeGatewayFault {
  /** It is processed, and the caller sees a timeout: the outcome is unknown to it. */
  AnswerThenDrop = "answer-then-drop",
  /** It fails before anything is processed. */
  FailBeforeProcessing = "fail-before-processing",
  /** It answers only after `delay` on the clock. */
  Slow = "slow",
}

/** The gateway's answer to a charge. */
export interface FakeGatewayReceipt {
  readonly paymentId: string;
  readonly amount: number;
  /** How many times this payment was answered (a fresh answer counts up; the first one is 1). */
  readonly answer: number;
}

/** A charge as the gateway is asked for it: an amount, under a client key. */
export interface FakeGatewayCharge {
  readonly amount: number;
  readonly idempotencyKey: string;
}

/** One payment the gateway made. */
export interface FakeGatewayPayment {
  readonly paymentId: string;
  readonly idempotencyKey: string;
  readonly amount: number;
  /** When it was made, on the clock (ms). */
  readonly madeAt: number;
  readonly firstReceipt: FakeGatewayReceipt;
}

/** A fault for the next charges: which, how many times, and a slow one's delay. */
export interface FakeGatewayFaultOptions {
  readonly times?: number;
  readonly delay?: Milliseconds;
}

/** What the gateway is built with. */
export interface FakeOutboundGatewayOptions {
  readonly clock: Clock;
  readonly capabilities?: Partial<FakeGatewayCapabilities>;
}

/** Why the fake gateway refused or lost a call. */
export enum FakeGatewayErrorKind {
  /** It processed the call, and the caller saw no answer. */
  Timeout = "timeout",
  /** It processed nothing. */
  Unavailable = "unavailable",
  /** The same key came with other parameters (G5). */
  Conflict = "conflict",
  /** It has no lookup by key (G2 off). */
  NoLookup = "no-lookup",
}

/**
 * The fake gateway refused or lost a call; `kind` says why. The other system's own error, never a
 * framework one (`agboss/testing` exports no `AGBossError` to throw by name): a plain `Error` with
 * its own `code`, as a provider SDK's.
 */
export class FakeGatewayError extends Error {
  static readonly code: string = "fake-gateway";
  readonly code: string = FakeGatewayError.code;
  override name = "FakeGatewayError";

  constructor(
    readonly kind: FakeGatewayErrorKind,
    message: string,
  ) {
    super(message);
  }
}

interface PendingFault {
  readonly fault: FakeGatewayFault;
  times: number;
  readonly delay: Milliseconds;
}

export class FakeOutboundGateway {
  readonly capabilities: FakeGatewayCapabilities;
  readonly #clock: Clock;
  readonly #payments: FakeGatewayPayment[] = [];
  readonly #answers = new Map<string, number>();
  readonly #faults: PendingFault[] = [];

  constructor(options: FakeOutboundGatewayOptions) {
    this.#clock = options.clock;
    this.capabilities = Object.freeze({ ...FULL_GATEWAY_CAPABILITIES, ...options.capabilities });
  }

  /** Every payment made, in order: what a double charge shows up in. */
  get payments(): readonly FakeGatewayPayment[] {
    return [...this.#payments];
  }

  /** The next `times` charges (default 1) meet `fault`. */
  injectFault(fault: FakeGatewayFault, options: FakeGatewayFaultOptions = {}): void {
    this.#faults.push({ fault, times: options.times ?? 1, delay: options.delay ?? seconds(0) });
  }

  /** Charges `amount` under its key, as the capabilities and the faults say. */
  async charge(request: FakeGatewayCharge): Promise<FakeGatewayReceipt> {
    const fault = this.#nextFault();
    if (fault?.fault === FakeGatewayFault.FailBeforeProcessing)
      throw new FakeGatewayError(
        FakeGatewayErrorKind.Unavailable,
        "the gateway is unavailable: nothing was processed",
      );
    if (fault?.fault === FakeGatewayFault.Slow) await this.#clock.sleep(fault.delay);
    const receipt = this.#processed(request);
    if (fault?.fault === FakeGatewayFault.AnswerThenDrop)
      throw new FakeGatewayError(
        FakeGatewayErrorKind.Timeout,
        "the gateway did not answer in time",
      );
    return receipt;
  }

  /** The payment made with `idempotencyKey` (G2); without the capability there is no such endpoint. */
  lookup(idempotencyKey: string): Promise<FakeGatewayReceipt | undefined> {
    if (!this.capabilities.lookupByKey)
      return Promise.reject(
        new FakeGatewayError(FakeGatewayErrorKind.NoLookup, "the gateway has no lookup by key"),
      );
    return Promise.resolve(this.#kept(idempotencyKey)?.firstReceipt);
  }

  #nextFault(): PendingFault | undefined {
    const [fault] = this.#faults;
    if (fault === undefined) return undefined;
    fault.times -= 1;
    if (fault.times <= 0) this.#faults.shift();
    return fault;
  }

  /** The payment of a key still within its retention, when keys are kept at all. */
  #kept(idempotencyKey: string): FakeGatewayPayment | undefined {
    if (!this.capabilities.idempotencyKeys) return undefined;
    const now = this.#clock.now().getTime();
    return this.#payments.findLast(
      (payment) =>
        payment.idempotencyKey === idempotencyKey &&
        now - payment.madeAt <= this.capabilities.keyRetention,
    );
  }

  #processed(request: FakeGatewayCharge): FakeGatewayReceipt {
    const kept = this.#kept(request.idempotencyKey);
    if (kept === undefined) return this.#made(request);
    if (kept.amount !== request.amount && this.capabilities.conflictOnMismatch)
      throw new FakeGatewayError(
        FakeGatewayErrorKind.Conflict,
        `key ${request.idempotencyKey} was used with other parameters`,
      );
    if (this.capabilities.firstResponseOnRepeat) return kept.firstReceipt;
    const answer = (this.#answers.get(kept.paymentId) ?? 1) + 1;
    this.#answers.set(kept.paymentId, answer);
    return { ...kept.firstReceipt, answer };
  }

  #made(request: FakeGatewayCharge): FakeGatewayReceipt {
    const paymentId = `pay-${String(this.#payments.length + 1)}`;
    const firstReceipt = { paymentId, amount: request.amount, answer: 1 };
    this.#payments.push({
      paymentId,
      idempotencyKey: request.idempotencyKey,
      amount: request.amount,
      madeAt: this.#clock.now().getTime(),
      firstReceipt,
    });
    return firstReceipt;
  }
}
