import { issuedKey } from "../infrastructure/issued-keys.js";
import {
  fingerprintsOf,
  BusinessKeyConflictError,
  isKeyFingerprint,
} from "../infrastructure/fenced-effect-key.js";
import { OutboundCallLeaseState } from "../infrastructure/execution-audit-log.repository.js";
import type {
  EffectKey,
  EffectKeyFields,
  FencedEffectOrigin,
  OutboundCallKey,
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

/**
 * The key with its fingerprint (#825): the request's — under the application's idempotency key, and
 * its previous one during a rotation — when a business key names none (`OutboundCalls.send` refuses
 * `FingerprintPolicy.None` before: a call's request is always its fingerprint).
 */
export function keyedByRequest(key: EffectKey | OutboundCallKey, request: unknown): EffectKey {
  if (key.businessKey === undefined || key.fingerprint !== undefined) return key as EffectKey;
  const fields: EffectKeyFields = key;
  return issuedKey({ ...fields, ...fingerprintsOf(request, key.name) }) as EffectKey;
}

/**
 * The idempotency key sent with the call: the step's key and the name — or, with a business key,
 * the tenant, the business key and the name, the same from every step and execution. Each part is
 * unambiguous (#508): the tenant and the business key `encodeURIComponent`-encoded, the name
 * without a `:` (`effectKeyOf` checks it), so two keys never give one string.
 */
export const callKeyOf = (key: EffectKey): string =>
  key.businessKey === undefined
    ? `${key.idempotencyKey}:${key.name}`
    : `${encodeURIComponent(key.tenantId)}:${encodeURIComponent(key.businessKey)}:${key.name}`;

/**
 * Checks a found intent (#505, #508): under a business key another fingerprint is
 * `BusinessKeyConflictError`; for any key, a pending attempt whose owner lives is
 * `OutboundCallInFlightError` — never reconciled or resent. Its owner is its `attemptOwner`: alive
 * when this instance is sending under it now, whatever the key; under a business key also while
 * the lease that wrote it is live on another instance (released only once its attempts settled,
 * never yielded under one); one expired is closed by the check (`leaseStateOf`: `LeaseClosed`, what
 * the caller tells), so its holder writes nothing under it again, and the attempt is reconciled here. The lease this step runs under
 * is this instance's: an attempt it wrote whose owner is not sending here has ended. One that ended
 * is reconciled by whoever wins the compare-and-set.
 */
export async function checkedCall<TRequest, TResult>(
  run: CallRun<TRequest, TResult>,
  found: OutboundCallRecord,
): Promise<OutboundCallLeaseState | undefined> {
  const { key, options } = run;
  // #825: the current idempotency key's fingerprint, or the previous one's during a rotation
  if (key.businessKey !== undefined && !isKeyFingerprint(key, found.fingerprint))
    throw new BusinessKeyConflictError({ effect: key.name, businessKeyHash: key.businessKeyHash });
  if (found.status !== OutboundCallStatus.Pending) return undefined;
  const inFlight = new OutboundCallInFlightError({ ...options, call: key.name });
  if (run.parts.owners.has(found.attemptOwner)) throw inFlight;
  if (key.businessKey === undefined) return undefined;
  // the caller holds this lease's current token: an older one of it is ended whatever its token
  if (found.leaseExecutionId === key.leaseExecutionId) return undefined;
  const { tenantId, leaseExecutionId, token } = found;
  const state = await run.parts.repository.leaseStateOf({ tenantId, leaseExecutionId, token });
  if (state === OutboundCallLeaseState.Live) throw inFlight;
  return state;
}

/**
 * How an error names a call's key: a business key only by its keyed handle (#508), never as it is
 * — `business-key:<handle>:<name>`, or `business-key:<name>` where no handle could be made.
 */
export function reportedKeyOf(key: EffectKey, idempotencyKey: string): string {
  if (key.businessKey === undefined) return idempotencyKey;
  const handle = key.businessKeyHash === undefined ? "" : `${key.businessKeyHash}:`;
  return `business-key:${handle}${key.name}`;
}

/** The step a replayed call was made by, when it is another step or execution (#508). */
export function replayedFromOf(
  key: EffectKey,
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
