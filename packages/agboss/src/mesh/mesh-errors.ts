import { LimitError } from "../core/error-families/limit-errors.js";
import { type Usd } from "../units/index.js";
import type { UsageRecord } from "../finops/usage.js";

/**
 * The mesh's limits (#398 S2 Q4): a request that comes back to an application's start it already
 * passed through, or one more hop than the receiver's `@Application({ maxMeshHops })`, is refused
 * before it runs — and on the caller the call's tool fails its step with the same class (the model
 * never reads it: retrying would loop again), so `.onError(LimitError.MeshLoop, …)` takes it. Both
 * are `LimitError`s: their side paths lead to actions and finishes only.
 */

/** Where in the caller's execution the limit was met: its path, its spend and spend not in state yet. */
export interface MeshLimitPlace {
  /** The execution's path so far. */
  readonly path: readonly string[];
  /** What the execution spent so far, in USD. */
  readonly spentUsd: Usd;
  /** Spend the execution's state does not hold yet (the agent loop's), so the ledger sees it. */
  readonly usage: readonly UsageRecord[];
}

/** One of the two mesh limits. */
export type MeshLimitError = LimitError.MeshLoop | LimitError.Hops;

/** Whether an error is a mesh limit (a tool that met one fails its step with it). */
export const isMeshLimitError = (error: unknown): error is MeshLimitError =>
  error instanceof LimitError.MeshLoop || error instanceof LimitError.Hops;

/** The same limit at another place (the agent loop's path and spend, before it fails the step). */
export function meshLimitAt(error: MeshLimitError, place: MeshLimitPlace): MeshLimitError {
  return error instanceof LimitError.MeshLoop
    ? new LimitError.MeshLoop({
        meshEntry: error.meshEntry,
        callChain: error.callChain,
        isRemote: error.isRemote,
        ...place,
      })
    : new LimitError.Hops({
        meshEntry: error.meshEntry,
        callChain: error.callChain,
        maxMeshHops: error.limit,
        isRemote: error.isRemote,
        ...place,
      });
}
