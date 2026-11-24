import { type Usd, usd } from "../units/index.js";
import type { UsageRecord } from "../finops/usage.js";
import { LimitExceededError } from "../graph/limits.js";
import { chainText, type MeshEntry, type MeshHop } from "./mesh-hop.js";

/**
 * The mesh's limits (#398 S2 Q4): a request that comes back to an application's start it already
 * passed through, or one more hop than the receiver's `@Application({ maxMeshHops })`, is refused
 * before it runs — and on the caller the call's tool fails its step with the same class (the model
 * never reads it: retrying would loop again), so `.onError(MeshLoopDetectedError, …)` takes it. Both
 * are `LimitExceededError`s: their side paths lead to actions and finishes only.
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

/** What a mesh limit error takes (#906): the entry, the chain, and — if known — the place. */
export interface MeshLoopDetectedErrorOptions extends Partial<MeshLimitPlace> {
  /** The entry that was called again: the receiver's application and start. */
  readonly entry: MeshEntry;
  /** The applications the request passed through, the first caller first. */
  readonly callChain: readonly MeshHop[];
  readonly cause?: unknown;
}

/** What a hops limit error takes (#906). */
export interface HopsLimitExceededErrorOptions extends MeshLoopDetectedErrorOptions {
  /** The receiver's `@Application({ maxMeshHops })`. */
  readonly maxMeshHops: number;
}

/** The same `(application, start)` twice in one call chain (#398 S2 Q9): always a loop. */
export class MeshLoopDetectedError extends LimitExceededError {
  static override readonly code = "limit.mesh-loop" as const;
  declare readonly code: typeof MeshLoopDetectedError.code;
  override name = "MeshLoopDetectedError";
  /** The entry that was called again: the receiver's application and start. */
  readonly entry: MeshEntry;
  /** The applications the request passed through, the first caller first. */
  readonly callChain: readonly MeshHop[];

  constructor(options: MeshLoopDetectedErrorOptions) {
    const { entry, callChain, path = [], spentUsd = usd(0), usage = [], cause } = options;
    const line = chainText([...callChain, entry]);
    super({
      key: "mesh.callChain",
      limit: 1,
      actual: 2,
      path,
      spentUsd,
      usage,
      cause,
      message: `${entry.application} › ${entry.start} was called again through the mesh: ${line}`,
      details: { entry: { ...entry }, chain: callChain.map((hop) => ({ ...hop })) },
    });
    this.entry = entry;
    this.callChain = callChain;
  }
}

/** A call chain one hop longer than the receiver's `@Application({ maxMeshHops })` allows. */
export class HopsLimitExceededError extends LimitExceededError {
  static override readonly code = "limit.hops" as const;
  declare readonly code: typeof HopsLimitExceededError.code;
  override name = "HopsLimitExceededError";
  /** The entry that refused the request: the receiver's application and start. */
  readonly entry: MeshEntry;
  /** The applications the request passed through, the first caller first. */
  readonly callChain: readonly MeshHop[];
  /** The receiver's `@Application({ maxMeshHops })`. */
  readonly maxMeshHops: number;
  /** The applications the chain would reach with the receiver: one more than `maxMeshHops`. */
  readonly hops: number;

  constructor(options: HopsLimitExceededErrorOptions) {
    const {
      entry,
      callChain,
      maxMeshHops,
      path = [],
      spentUsd = usd(0),
      usage = [],
      cause,
    } = options;
    const hops = callChain.length + 1;
    super({
      key: "maxMeshHops",
      limit: maxMeshHops,
      actual: hops,
      path,
      spentUsd,
      usage,
      cause,
      message:
        `${entry.application} › ${entry.start} would be hop ${String(hops)} of the call chain; ` +
        `its maxMeshHops is ${String(maxMeshHops)}: ${chainText(callChain)}`,
      details: {
        entry: { ...entry },
        chain: callChain.map((hop) => ({ ...hop })),
        maxMeshHops,
        hops,
      },
    });
    this.entry = entry;
    this.callChain = callChain;
    this.maxMeshHops = maxMeshHops;
    this.hops = hops;
  }
}

/** One of the two mesh limits. */
export type MeshLimitError = MeshLoopDetectedError | HopsLimitExceededError;

/** Whether an error is a mesh limit (a tool that met one fails its step with it). */
export const isMeshLimitError = (error: unknown): error is MeshLimitError =>
  error instanceof MeshLoopDetectedError || error instanceof HopsLimitExceededError;

/** The same limit at another place (the agent loop's path and spend, before it fails the step). */
export function meshLimitAt(error: MeshLimitError, place: MeshLimitPlace): MeshLimitError {
  return error instanceof MeshLoopDetectedError
    ? new MeshLoopDetectedError({ entry: error.entry, callChain: error.callChain, ...place })
    : new HopsLimitExceededError({
        entry: error.entry,
        callChain: error.callChain,
        maxMeshHops: error.maxMeshHops,
        ...place,
      });
}
