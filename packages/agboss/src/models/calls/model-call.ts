import type { Clock } from "../../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../../infrastructure/clock-timeout.js";
import { currentFrame } from "../../flow/context/frame.js";
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_WEIGHT } from "../../flow/context/tenant-context.js";
import type { Milliseconds } from "../../units/index.js";
import { failureOfError, failureOfStatus, type ModelFailure } from "../model-failure.js";
import { FREE_PASS } from "./gate-pass.js";
import type { GateTicket } from "./gate-waiter.js";
import type { ProviderGate } from "./provider-gate.js";
import { releasedAtBodyEnd } from "./response-usage.js";

/**
 * One attempt of a model call (#266): the tenant-fair queue and a slot of the provider's
 * `rateLimitPolicy` first, then the attempt's `timeout` starts (waiting for room never counts
 * toward it), the call, and the room released with the call's real usage — when its answer has
 * been read to the end, or at once for a failure. Retries happen outside: a backoff wait holds no
 * slot, and the next attempt queues again on equal terms.
 */

/** The HTTP client of a provider: `fetch` with its timeout, rate limit, retries and breaker. */
export type ProviderFetch = typeof fetch;

/** How an attempt ended: an answer (with the failure its status means) or a thrown error. */
export type Attempt =
  | { readonly kind: "answered"; readonly response: Response; readonly failure?: ModelFailure }
  | { readonly kind: "threw"; readonly error: unknown; readonly failure: ModelFailure };

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

/** The request under the attempt's timeout on the clock (and the caller's own signal). */
async function sendTimed(
  send: ProviderFetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  limits: AttemptLimits,
): Promise<Attempt> {
  const timer = timeoutOn(limits.clock, limits.timeout, timeoutError);
  const signals = [timer.signal, ...(init?.signal ? [init.signal] : [])];
  try {
    const response = await send(input, { ...init, signal: AbortSignal.any(signals) });
    const failure = failureOfStatus(response.status);
    return failure === undefined
      ? { kind: "answered", response }
      : { kind: "answered", response, failure };
  } catch (error) {
    if (init?.signal?.aborted === true) throw error;
    return { kind: "threw", error, failure: failureOfError(error) };
  } finally {
    timer.release();
  }
}

/** One attempt: room first, then the timed call; the room is held until the answer is read. */
export async function attemptOnce(
  send: ProviderFetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
  limits: AttemptLimits,
): Promise<Attempt> {
  const pass =
    limits.gate === undefined ? FREE_PASS : await limits.gate.enter(ticketOf(init?.signal));
  let attempt: Attempt;
  try {
    attempt = await sendTimed(send, input, init, limits);
  } catch (error) {
    await pass.release(0);
    throw error;
  }
  if (attempt.kind === "answered" && attempt.failure === undefined && pass !== FREE_PASS) {
    return { kind: "answered", response: releasedAtBodyEnd(attempt.response, pass.release) };
  }
  await pass.release(0);
  return attempt;
}
