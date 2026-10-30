import {
  businessKeyHashOf,
  fingerprintOf,
  IdempotencyKeyConflictError,
} from "../infrastructure/fenced-effect-key.js";
import type {
  FencedEffectKey,
  FencedEffectOrigin,
} from "../infrastructure/fenced-effect.repository.js";
import {
  OutboundCallStatus,
  type OutboundCallRecord,
  type OutboundCallState,
} from "../infrastructure/outbound-call.repository.js";
import type { CallRun } from "./outbound-call-parts.js";
import { OutboundCallInFlightError } from "./outbound-calls.js";

/**
 * A call that leaves the system under a business key (#508): one call per tenant, name and business
 * key — the second charge of `order:42` from another tool call, visit, execution or thread finds
 * the first. Its fingerprint is its request's unless the key names one; another fingerprint is a
 * conflict, never a replay; a pending call a live holder owns is in flight, never reconciled here.
 */

/** The key with its fingerprint: the request's, when a business key names none. */
export const keyedByRequest = (key: FencedEffectKey, request: unknown): FencedEffectKey =>
  key.businessKey === undefined || key.fingerprint !== undefined
    ? key
    : { ...key, fingerprint: fingerprintOf(request) };

/**
 * The idempotency key sent with the call: the step's key and the name — or, with a business key,
 * the tenant, the business key and the name, the same from every step and execution.
 */
export const callKeyOf = (key: FencedEffectKey): string =>
  key.businessKey === undefined
    ? `${key.idempotencyKey}:${key.name}`
    : `${encodeURIComponent(key.tenantId)}:${key.businessKey}:${key.name}`;

/**
 * Checks a found intent of a business key: another fingerprint → `IdempotencyKeyConflictError`;
 * pending while its attempt's owner lives → `OutboundCallInFlightError`. The owner is the attempt's
 * `attemptOwner`: alive here when this instance is sending under it now; else alive when the lease
 * that wrote the attempt is held by another instance. The lease this step runs under is held here,
 * so an attempt it wrote whose owner is not sending here has ended: it is reconciled, by whoever
 * wins the compare-and-set.
 */
export async function checkedBusinessCall<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): Promise<void> {
  const { key, options } = run;
  if (key.businessKey === undefined) return;
  if (found.fingerprint !== key.fingerprint)
    throw new IdempotencyKeyConflictError({ name: key.name, businessKey: key.businessKey });
  if (found.status !== OutboundCallStatus.Pending) return;
  const inFlight = new OutboundCallInFlightError({ ...options, name: key.name });
  if (run.parts.owners.has(found.attemptOwner)) throw inFlight;
  const isHeldHere = found.leaseExecutionId === key.leaseExecutionId && found.token === key.token;
  if (isHeldHere) return;
  const lease = [found.tenantId, found.leaseExecutionId, found.token] as const;
  if (await run.parts.repository.isLeaseHeld(...lease)) throw inFlight;
}

/** How an error names a call's key: a business key only by its hash (#508), never as it is. */
export const reportedKeyOf = (key: FencedEffectKey, idempotencyKey: string): string =>
  key.businessKey === undefined
    ? idempotencyKey
    : `business-key:${businessKeyHashOf(key.businessKey)}:${key.name}`;

/** The step a replayed call was made by, when it is another step or execution (#508). */
export function replayedFromOf(
  key: FencedEffectKey,
  found: OutboundCallRecord,
): FencedEffectOrigin | undefined {
  const origin = {
    executionId: found.executionId,
    nodeId: found.step.nodeId,
    visitNumber: found.step.visitNumber,
  };
  const isSame =
    key.origin?.executionId === origin.executionId &&
    key.origin.nodeId === origin.nodeId &&
    key.origin.visitNumber === origin.visitNumber;
  return isSame ? undefined : origin;
}

/** The state `markPending` expects of `found`: as it was read. */
export const stateOf = (found: OutboundCallRecord): OutboundCallState => ({
  status: found.status,
  attempt: found.attempt,
  attemptOwner: found.attemptOwner,
});
