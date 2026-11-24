import { ConfigError } from "../../core/error-families/config-errors.js";
import type { Clock } from "../../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../../infrastructure/clock.js";
import { currentFrame } from "../../flow/context/frame.js";
import {
  DEFAULT_TENANT_ID,
  DEFAULT_TENANT_WEIGHT,
  type TenantContext,
} from "../../flow/context/tenant-context.js";
import type { Milliseconds } from "../../units/index.js";
import type { ModelFailure } from "../model-failure.js";
import { FREE_PASS } from "./gate-pass.js";
import type { GateTicket } from "./gate-waiter.js";
import { type RateLimitPolicy } from "../policies/rate-limit-policy.js";
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
      /**
       * A streamed answer whose end is told to the breaker by its own body (#1005): a stream that
       * is cut after its text is no success, so the headers do not count as one.
       */
      readonly settledAtEnd?: true;
      /**
       * An answer with a client-error status that is no retried failure: `provider` — the provider
       * itself is at fault (its credential or quota: a 401, 402, or a 403, 404 whose body names the provider) — counts
       * as a failure of the breaker, `request` — the request was wrong (a 400, a 422) — tells it
       * nothing. Neither is a success: a breaker never closes on an error answer.
       */
      readonly refusal?: "provider" | "request";
    }
  | {
      readonly kind: "threw";
      readonly error: unknown;
      /**
       * The provider refused the request itself — a part it cannot take (#899): `error` is thrown as
       * it is, not retried, and the breaker is not told: a client's input error is no failure of the
       * provider.
       */
      readonly isRejected?: true;
      readonly failure?: ModelFailure;
      readonly retryAfter?: number;
    };

/** What carries a call's attempts: `fetch` for an HTTP provider, `complete()` for a transport. */
export interface AttemptCarrier<TAnswer> {
  /**
   * One attempt under `signal` (its timeout and the caller's own), ended as an `Attempt`; it
   * rejects only when the caller's own signal aborted. `limits` carries the timeout and the clock
   * for what runs after the attempt's head: a streamed body is bounded by a stall timeout (#1125).
   */
  readonly send: (signal: AbortSignal, limits: AttemptLimits) => Promise<Attempt<TAnswer>>;
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

/** The weight the provider's `tenantWeight` gives a tenant: a whole number from 1 (1 without one). */
function weightOf(tenant: TenantContext, tenantWeight: RateLimitPolicy["tenantWeight"]): number {
  const weight = tenantWeight?.(tenant) ?? DEFAULT_TENANT_WEIGHT;
  if (!Number.isInteger(weight) || weight < 1)
    throw new ConfigError.RateLimitPolicy({
      message: `tenantWeight gave ${String(weight)} for tenant "${tenant.tenantId}": it must be an integer ≥ 1`,
    });
  return weight;
}

/**
 * Who waits for room: the current execution's tenant (`"default"`, weight 1, outside one), its
 * wait ended by the call's own signal or the execution's (`app.cancel`).
 */
export function ticketOf(
  signal: AbortSignal | null | undefined,
  tenantWeight?: RateLimitPolicy["tenantWeight"],
): GateTicket {
  const execution = currentFrame()?.execution;
  const signals = [signal ?? undefined, execution?.signal].filter(
    (each): each is AbortSignal => each !== undefined,
  );
  return {
    tenantId: execution?.tenant.tenantId ?? DEFAULT_TENANT_ID,
    weight:
      execution === undefined ? DEFAULT_TENANT_WEIGHT : weightOf(execution.tenant, tenantWeight),
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
    return await carrier.send(AbortSignal.any(signals), limits);
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
  const pass =
    limits.gate === undefined
      ? FREE_PASS
      : await limits.gate.enter(ticketOf(caller, limits.gate.tenantWeight));
  let attempt: Attempt<TAnswer>;
  try {
    attempt = await sendTimed(carrier, limits, caller);
  } catch (error) {
    await pass.release(0);
    throw error;
  }
  if (attempt.kind === "answered" && attempt.failure === undefined && pass !== FREE_PASS) {
    return { ...attempt, answer: carrier.hold(attempt.answer, pass.release) };
  }
  await pass.release(0);
  return attempt;
}
