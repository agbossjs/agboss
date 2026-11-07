import { errorRecordOf } from "../core/error-record.js";
import { ExecutionFencedError } from "./lease-lost.js";
import { OutboundCallEventOutcome } from "../infrastructure/execution-lease-event.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRecord,
} from "../infrastructure/outbound-call.repository.js";
import { replayedFromOf, reportedKeyOf } from "./outbound-call-business.js";
import { OutboundCallSupersededError } from "./outbound-call-contract.js";
import {
  maskedTextOf,
  notStoredOf,
  outcomeOf,
  subjectOf,
  told,
  type CallRun,
} from "./outbound-call-parts.js";
import {
  OutboundCallSendStatus,
  OutboundCallResultNotStoredError,
  OutboundCallUnreconciledError,
  type OutboundCallOutcome,
} from "./outbound-calls.js";

/**
 * How a call ends (#505, #508), loaded with the protocol: replayed from a completed intent, or
 * badly — superseded by a newer attempt while it was in flight (an error, #795), or left pending with no verdict
 * `reconcile` could give.
 */

/**
 * Attempt `attempt` was answered after a newer one took the intent over (#508): both reached the
 * other system. Told as `AttemptSuperseded`, naming the newer attempt when the intent can still be read —
 * else "unknown", never a guess — and logged as an error on the instance's log, lease or none. The
 * newer attempt, `undefined` when unknown (#795: `OutboundCallSupersededError.supersededBy`).
 */
export async function superseded<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
): Promise<number | undefined> {
  // the read is for the report only: its failure is named, never thrown over the superseded error
  let unread = "";
  const found = await run.parts.repository.findByKey(run.key).catch((error: unknown) => {
    unread = ` (the intent could not be read: ${errorRecordOf(error).code})`;
    return undefined;
  });
  const newer = found === undefined || found.attempt === attempt ? undefined : found.attempt;
  const status = found?.status ?? OutboundCallStatus.Pending;
  told(run, OutboundCallEventOutcome.AttemptSuperseded, [status, attempt], { supersededBy: newer });
  const { name } = run.key;
  const { operation, target } = run.options;
  const by =
    newer === undefined ? "a newer attempt (which one is unknown)" : `attempt ${String(newer)}`;
  const text = `outbound call "${name}" (${operation} on ${target}) attempt ${String(attempt)} was answered after ${by} took its intent over${unread}: both reached ${target} — check it there`;
  run.parts.log.error("outbound-call.superseded", text, subjectOf(run));
  return newer;
}

/**
 * Attempt `attempt` was answered after a newer one took its intent over (#795): told and logged
 * (`superseded`), then the error the step fails with — never a normal outcome.
 */
export async function supersededErrorOf<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  cause?: unknown,
): Promise<OutboundCallSupersededError> {
  const supersededBy = await superseded(run, attempt);
  const idempotencyKey = reportedKeyOf(run.key, run.idempotencyKey);
  const { target, operation } = run.options;
  return new OutboundCallSupersededError(
    {
      ...{ name: run.key.name, target, operation, idempotencyKey },
      ...{ attempt, supersededBy },
    },
    cause,
  );
}

/**
 * Writes the end of attempt `attempt` (`write`, fenced): a refusal — its lease handed over while it
 * was in flight, its answer come too late — is logged as an error, then thrown: the answer is not
 * stored, the new holder reconciles the intent, the other system may have it twice.
 */
export async function fencedEnd<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  attempt: number,
  write: () => Promise<boolean>,
): Promise<boolean> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof ExecutionFencedError) {
      const { name } = run.key;
      const { operation, target } = run.options;
      const text = `outbound call "${name}" (${operation} on ${target}) attempt ${String(attempt)} was answered after its lease was handed over: the answer is not stored and the new holder reconciles the intent — check ${target} if it was sent again`;
      run.parts.log.error("outbound-call.answered-after-hand-over", text, subjectOf(run));
    }
    throw error;
  }
}

/**
 * `found` was pending under another execution's lease, expired and closed by this call's check
 * (#508): told `LeaseClosed`, naming that lease and the token it was held at, and logged as a
 * warning — its holder writes nothing under it again; what it still sends is fenced.
 */
export function leaseClosed<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): void {
  const { rootExecutionId, leaseExecutionId, token } = found;
  const closedLease = { rootExecutionId, leaseExecutionId, token };
  const moved = [found.status, found.attempt] as const;
  told(run, OutboundCallEventOutcome.LeaseClosed, moved, { closedLease });
  const { operation, target } = run.options;
  const text = `outbound call "${run.key.name}" (${operation} on ${target}) attempt ${String(found.attempt)} was pending under the lease of execution ${leaseExecutionId} at token ${String(token)}, expired: closed, the call is reconciled here — a send of it still hung may reach ${target} too, deduplicated only by call.idempotencyKey`;
  run.parts.log.warn("outbound-call.lease-closed", text, subjectOf(run));
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

/**
 * A completed intent's stored result — masked by the PII policies — and who made it (#508); one
 * whose result was not stored is `OutboundCallResultNotStoredError`, nothing sent again.
 */
export function replayed<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): OutboundCallOutcome<TResult> {
  const stored: unknown = JSON.parse(found.result ?? "null");
  // answered, its result not stored (#508): no result to give, never the marker as one
  const notStored = notStoredOf(stored);
  if (notStored !== undefined)
    throw new OutboundCallResultNotStoredError({ ...run.options, name: run.key.name }, notStored);
  const replayedFrom = replayedFromOf(run.key, found);
  const moved = [OutboundCallStatus.Completed, found.attempt] as const;
  told(run, OutboundCallEventOutcome.Replayed, moved, { replayedFrom });
  const outcome = outcomeOf(run, OutboundCallSendStatus.Replayed, stored, found.attempt);
  return replayedFrom === undefined ? outcome : { ...outcome, replayedFrom };
}
