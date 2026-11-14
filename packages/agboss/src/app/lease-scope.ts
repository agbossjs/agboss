import { AsyncLocalStorage } from "node:async_hooks";
import { currentFrame, type FrameLease } from "../flow/context/frame.js";

/**
 * Where a store call runs under a lease (#928): the step's frame carries its lease, and work that
 * holds a lease outside any frame — a pass's end, a tree ended without a pass, a child's run up to
 * its completion, a checkpoint write — opens `leaseScope(lease, work)`. `outsideLease(work)` marks
 * work that is never a hand-over even inside a frame (the audit rows of a hand-over).
 */

/** What the current async context says: the lease of its work, `null` = none, whatever the frame. */
interface Scope {
  readonly lease: FrameLease | null;
  /** The call is a renewal that hands over when unanswered (`renewNow`, #928). */
  readonly isRenewal: boolean;
}

const storage = new AsyncLocalStorage<Scope>();

/** Runs `work` as work held by `lease`: its store calls are bounded by the lease's trust. */
export const leaseScope = <T>(lease: FrameLease, work: () => Promise<T>): Promise<T> =>
  storage.run({ lease, isRenewal: false }, work);

/** Runs `work` outside any lease: its store calls are bounded, never a hand-over. */
export const outsideLease = <T>(work: () => Promise<T>): Promise<T> =>
  storage.run({ lease: null, isRenewal: false }, work);

/** Runs a renewal of `lease` that hands over when it is unanswered (`renewNow`'s). */
export const leasedRenewal = <T>(lease: FrameLease, work: () => Promise<T>): Promise<T> =>
  storage.run({ lease, isRenewal: true }, work);

/** The lease a store call started now runs under, and whether it is a leased renewal. */
export interface CallScope {
  readonly lease: FrameLease | undefined;
  readonly isRenewal: boolean;
}

/** The scope of a call started now: the scope's lease, else the frame's; none outside both. */
export function callScopeOf(): CallScope {
  const scope = storage.getStore();
  if (scope?.lease === null) return { lease: undefined, isRenewal: false };
  // an explicit scope is more specific than the frame the work happens to run inside
  const lease = scope?.lease ?? currentFrame()?.execution.lease;
  return { lease, isRenewal: scope?.isRenewal === true };
}
