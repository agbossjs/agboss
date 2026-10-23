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
  readonly spentUsd: number;
  /** Spend the execution's state does not hold yet (the agent loop's), so the ledger sees it. */
  readonly usage: readonly UsageRecord[];
}

const NOWHERE: MeshLimitPlace = { path: [], spentUsd: 0, usage: [] };

/** The same `(application, start)` twice in one call chain (#398 S2 Q9): always a loop. */
export class MeshLoopDetectedError extends LimitExceededError {
  static override readonly code: string = "limit.mesh-loop";
  override name = "MeshLoopDetectedError";
  /** The entry that was called again: the receiver's application and start. */
  readonly entry: MeshEntry;
  /** The applications the request passed through, the first caller first. */
  readonly chain: readonly MeshHop[];

  constructor(entry: MeshEntry, chain: readonly MeshHop[], place: MeshLimitPlace = NOWHERE) {
    const line = chainText([...chain, entry]);
    super({ key: "mesh.callChain", limit: 1, actual: 2 }, place.path, place.spentUsd, place.usage, {
      message: `${entry.application} › ${entry.start} was called again through the mesh: ${line}`,
      details: { entry: { ...entry }, chain: chain.map((hop) => ({ ...hop })) },
    });
    this.entry = entry;
    this.chain = chain;
  }
}

/** A call chain one hop longer than the receiver's `@Application({ maxMeshHops })` allows. */
export class HopsLimitExceededError extends LimitExceededError {
  static override readonly code: string = "limit.hops";
  override name = "HopsLimitExceededError";
  /** The entry that refused the request: the receiver's application and start. */
  readonly entry: MeshEntry;
  /** The applications the request passed through, the first caller first. */
  readonly chain: readonly MeshHop[];
  /** The receiver's `@Application({ maxMeshHops })`. */
  readonly maxMeshHops: number;
  /** The applications the chain would reach with the receiver: one more than `maxMeshHops`. */
  readonly hops: number;

  constructor(
    entry: MeshEntry,
    chain: readonly MeshHop[],
    maxMeshHops: number,
    place: MeshLimitPlace = NOWHERE,
  ) {
    const hops = chain.length + 1;
    const breach = { key: "maxMeshHops", limit: maxMeshHops, actual: hops };
    const text = {
      message:
        `${entry.application} › ${entry.start} would be hop ${String(hops)} of the call chain; ` +
        `its maxMeshHops is ${String(maxMeshHops)}: ${chainText(chain)}`,
      details: {
        entry: { ...entry },
        chain: chain.map((hop) => ({ ...hop })),
        maxMeshHops,
        hops,
      },
    };
    super(breach, place.path, place.spentUsd, place.usage, text);
    this.entry = entry;
    this.chain = chain;
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
    ? new MeshLoopDetectedError(error.entry, error.chain, place)
    : new HopsLimitExceededError(error.entry, error.chain, error.maxMeshHops, place);
}
