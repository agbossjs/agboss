import { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRecord,
} from "../infrastructure/outbound-call.repository.js";
import { reportedKeyOf } from "./outbound-call-business.js";
import { maskedTextOf, told, type CallRun } from "./outbound-call-parts.js";
import { OutboundCallUnreconciledError } from "./outbound-calls.js";

/**
 * How an attempt ends badly (#505, #508), loaded with the protocol: superseded by a newer attempt
 * while it was in flight, or left pending with no verdict `reconcile` could give.
 */

/**
 * Attempt `attempt` was answered after a newer one took the intent over (#508): both reached the
 * other system. Told as `Superseded`, naming the newer attempt, and logged as an error.
 */
export async function superseded<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
): Promise<void> {
  const found = await run.parts.repository.findByKey(run.key).catch(() => undefined);
  const newer = found?.attempt ?? attempt + 1;
  const status = found?.status ?? OutboundCallStatus.Pending;
  told(run, OutboundCallEventOutcome.Superseded, [status, attempt], undefined, newer);
}

/**
 * `reconcile` could not settle `found` (#505): told `Unknown`, and the error to throw — its reason
 * masked by the frame's mask (#508), its key named by its handle only.
 */
export async function unreconciledOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
  reason: string,
  cause?: unknown,
): Promise<OutboundCallUnreconciledError> {
  told(run, OutboundCallEventOutcome.Unknown, [OutboundCallStatus.Pending, found.attempt]);
  const idempotencyKey = reportedKeyOf(run.key, run.idempotencyKey);
  const masked = await maskedTextOf(run, reason);
  return new OutboundCallUnreconciledError(
    { ...run.options, name: run.key.name, idempotencyKey, reason: masked },
    cause,
  );
}
