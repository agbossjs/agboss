import type { Class } from "../components/injection.js";
import { A2AFileRepository } from "../infrastructure/a2a-file.repository.js";
import { waitOf } from "../infrastructure/clock.js";
import { ExecutionLeaseRepository } from "../infrastructure/execution-lease.repository.js";
import type { FrameLease } from "../flow/context/frame.js";
import type { Milliseconds } from "../units/index.js";
import { LONG_CALL_BOUND, RENEW_BOUND, STORE_CALL_BOUND } from "./lease-fence.js";
import { callScopeOf } from "./lease-scope.js";

/**
 * How long a store call may take, and what happens at its bound (#928): decided when the call
 * starts, from the lease scope it runs in and from what it is.
 */

/** What the bound does when it fires. */
export enum StoreCallKind {
  /** Under a held lease: the holder hands the tree over (`abandon`). */
  Leased = "leased",
  /** Anywhere else: an ordinary store error. */
  Unleased = "unleased",
  /** A retention delete or an A2A file body: an ordinary store error after minutes, never a hand-over. */
  Long = "long",
}

/** The contract methods that prune a backlog: `delete…Before`. */
export const MAINTENANCE_METHODS = /^delete\w*Before$/u;

/** The contracts whose every call is long: a file body is not a fencing event. */
export const LONG_CONTRACTS: ReadonlySet<Class> = new Set<Class>([A2AFileRepository]);

/** What a call is bounded by, and the lease it hands over when it is leased. */
export interface StoreCallLimit {
  readonly kind: StoreCallKind;
  readonly bound: Milliseconds;
  /** The lease of a `Leased` call; `undefined` otherwise. */
  readonly lease: FrameLease | undefined;
}

/** The lease of a leased call when it is held, trusted and its parts are there (a unit runner has none). */
function trustedLease(lease: FrameLease | undefined, method: string): FrameLease | undefined {
  if (lease?.left === undefined || lease.signal === undefined || lease.abandon === undefined)
    return undefined;
  // a reclaim runs while the lease is yielded: its own token is what it asks for
  const isHeld =
    !lease.signal.aborted && lease.left > 0 && (method === "reclaim" || !lease.isYielded);
  return isHeld ? lease : undefined;
}

/** Whether a call of `contract` can be leased at all: the lease store only reclaims and renews on request. */
function canBeLeased(contract: Class, method: string, isRenewal: boolean): boolean {
  if (!(
    contract === ExecutionLeaseRepository || contract.prototype instanceof ExecutionLeaseRepository
  ))
    return true;
  return method === "reclaim" || (method === "renew" && isRenewal);
}

/** The limit of the call of `method` on a store of `contract` that starts now. */
export function limitOf(contract: Class, method: string): StoreCallLimit {
  const isLong = LONG_CONTRACTS.has(contract) || MAINTENANCE_METHODS.test(method);
  if (isLong) return { kind: StoreCallKind.Long, bound: LONG_CALL_BOUND, lease: undefined };
  const scope = callScopeOf();
  const lease = canBeLeased(contract, method, scope.isRenewal)
    ? trustedLease(scope.lease, method)
    : undefined;
  if (lease?.left === undefined) {
    const isRenewal = method === "renew" && contract === ExecutionLeaseRepository;
    const bound = isRenewal ? RENEW_BOUND : STORE_CALL_BOUND;
    return { kind: StoreCallKind.Unleased, bound, lease: undefined };
  }
  // fixed at the call's start: a renewal meanwhile does not extend it
  return { kind: StoreCallKind.Leased, bound: waitOf(lease.left), lease };
}
