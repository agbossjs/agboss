import type { Clock } from "../../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../../infrastructure/clock.js";
import { currentFrame } from "../../flow/context/frame.js";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_WEIGHT } from "../../flow/context/tenant-context.js";
import type { Milliseconds } from "../../units/index.js";
import type { ModelFailure } from "../model-failure.js";
import { FREE_PASS } from "./gate-pass.js";
import type { GateTicket } from "./gate-waiter.js";
import type { ProviderGate } from "./provider-gate.js";

/**
 * One attempt of a model call (#266), whatever carries it — HTTP or a transport's `complete()`
 * (#385): the tenant-fair queue and a slot of the provider's `rateLimitPolicy` first, then the
 * attempt's `timeout` starts (waiting for room never counts toward it), the call, and the room
 * released with the call's real usage — when its answer has been used up, or at once for a
 * failure. Retries happen outside: a backoff wait holds no slot, and the next attempt queues again
 * on equal terms.
 */

/** The HTTP client of a provider: `fetch` with its timeout, rate limit, retries and breaker. */
export type ProviderFetch = typeof fetch;

/**
 * How an attempt ended: an answer (with the failure it means — an HTTP status) or a thrown error
 * (with the failure it means, when it means one); `retryAfter` — what the provider asked to wait, ms.
 */
export type Attempt<TAnswer> =
  | {
      readonly kind: "answered";
      readonly answer: TAnswer;
      readonly failure?: ModelFailure;
      readonly retryAfter?: number;
    }
  | {
      readonly kind: "threw";
      readonly error: unknown;
      readonly failure?: ModelFailure;
      readonly retryAfter?: number;
    };

/** What carries a call's attempts: `fetch` for an HTTP provider, `complete()` for a transport. */
export interface AttemptCarrier<TAnswer> {
  /**
   * One attempt under `signal` (its timeout and the caller's own), ended as an `Attempt`; it
   * rejects only when the caller's own signal aborted.
   */
  readonly send: (signal: AbortSignal) => Promise<Attempt<TAnswer>>;
  /** A successful answer whose room is released once it is used up, with its real tokens. */
  readonly hold: (answer: TAnswer, release: (tokens: number) => Promise<void>) => TAnswer;
  /** An answer dropped for a retry (an HTTP body is cancelled). */
  readonly drop: (answer: TAnswer) => Promise<void>;
}

/** What one attempt runs under: the provider's gate (none = no limit), its timeout, the clock. */
export interface AttemptLimits {
  readonly gate: ProviderGate | undefined;
  readonly timeout: Milliseconds;
  readonly clock: Clock;
}

/**
 * Who waits for room: the current execution's tenant (`"default"`, weight 1, outside one), its
 * wait ended by the call's own signal or the execution's (`app.cancel`).
 */
export function ticketOf(signal: AbortSignal | null | undefined): GateTicket {
  const execution = currentFrame()?.execution;
  const signals = [signal ?? undefined, execution?.signal].filter(
    (each): each is AbortSignal => each !== undefined,
  );
  return {
    tenantId: execution?.tenant.tenantId ?? DEFAULT_TENANT_ID,
    weight: execution?.tenant.weight ?? DEFAULT_TENANT_WEIGHT,
    signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
  };
}

/** The attempt under its timeout on the clock (and the caller's own signal). */
async function sendTimed<TAnswer>(
  carrier: AttemptCarrier<TAnswer>,
  limits: AttemptLimits,
  caller: AbortSignal | null | undefined,
): Promise<Attempt<TAnswer>> {
  const timer = timeoutOn(limits.clock, limits.timeout, timeoutError);
  const signals = [timer.signal, ...(caller ? [caller] : [])];
  try {
    return await carrier.send(AbortSignal.any(signals));
  } finally {
    timer.release();
  }
}

/** One attempt: room first, then the timed call; the room is held until the answer is used up. */
export async function attemptOnce<TAnswer>(
  carrier: AttemptCarrier<TAnswer>,
  limits: AttemptLimits,
  caller: AbortSignal | null | undefined,
): Promise<Attempt<TAnswer>> {
  const pass = limits.gate === undefined ? FREE_PASS : await limits.gate.enter(ticketOf(caller));
  let attempt: Attempt<TAnswer>;
  try {
    attempt = await sendTimed(carrier, limits, caller);
  } catch (error) {
    await pass.release(0);
    throw error;
  }
  if (attempt.kind === "answered" && attempt.failure === undefined && pass !== FREE_PASS) {
    return { kind: "answered", answer: carrier.hold(attempt.answer, pass.release) };
  }
  await pass.release(0);
  return attempt;
}
