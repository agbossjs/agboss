import type { StoreHoldPoint } from "./store-points.js";

/**
 * The history of a fault run (#484, read by #533's linearizability checker): every store operation
 * a process made through a held store, as two events — its invoke, before the store is asked, and
 * its complete, once the store answered or threw. Each event carries the process's monotonic time
 * (`process.hrtime`, one clock for every process of the machine), so the history of several
 * processes is ordered by it: an operation whose complete comes before another's invoke happened
 * before it. An operation of a process killed in between has an invoke and no complete.
 */

/** One half of a store operation. */
export enum OperationPhase {
  Invoke = "invoke",
  Complete = "complete",
}

/** What one event of the history says. */
export interface OperationEvent {
  readonly phase: OperationPhase;
  /** The operation's id: `<process>#<n>`, the same on its invoke and its complete. */
  readonly id: string;
  /** The process (a pod's name) and the application instance that made it. */
  readonly process: string;
  readonly instanceId: string;
  /** The store operation: `lease.acquire`, `fencedEffect.write`, … */
  readonly operation: StoreHoldPoint;
  /** The operation's key: the lease's root execution, the effect's lease execution. */
  readonly key: string | undefined;
  /** On the invoke: what was asked (identities and tokens, never a payload). */
  readonly input?: unknown;
  /** On a complete that answered: what the store answered (a lease, a status, a flag). */
  readonly output?: unknown;
  /** On a complete that threw: the error's name and message. */
  readonly error?: { readonly name: string; readonly message: string };
  /** The process's monotonic time in nanoseconds (`process.hrtime.bigint()`), as text. */
  readonly at: string;
}

/** Where a held store reports its operations: the pod's control channel, a test's array. */
export interface OperationRecorder {
  record(event: OperationEvent): void;
}

/** One operation of the history: its invoke, and its complete once it came. */
export interface HistoryOperation {
  readonly invoke: OperationEvent;
  readonly complete?: OperationEvent;
}

/** The history of every process of a run, in the order its events happened. */
export class OperationHistory implements OperationRecorder {
  readonly #events: OperationEvent[] = [];

  record(event: OperationEvent): void {
    this.#events.push(event);
  }

  /** Every event, ordered by its monotonic time (the order of arrival breaks a tie). */
  get events(): readonly OperationEvent[] {
    return this.#events
      .map((event, index) => ({ event, index }))
      .sort((left, right) => compareAt(left.event.at, right.event.at) || left.index - right.index)
      .map(({ event }) => event);
  }

  /** Every operation, in the order of its invoke, each with its complete when it came. */
  get operations(): readonly HistoryOperation[] {
    const completes = new Map(
      this.#events
        .filter((event) => event.phase === OperationPhase.Complete)
        .map((event) => [event.id, event]),
    );
    return this.events
      .filter((event) => event.phase === OperationPhase.Invoke)
      .map((invoke) => {
        const complete = completes.get(invoke.id);
        return complete === undefined ? { invoke } : { invoke, complete };
      });
  }
}

/** Orders two monotonic times given as text. */
export const compareAt = (left: string, right: string): number => {
  const difference = BigInt(left) - BigInt(right);
  return difference === 0n ? 0 : difference < 0n ? -1 : 1;
};

/** The process's monotonic time now, as an event carries it. */
export const monotonicNow = (): string => process.hrtime.bigint().toString();
