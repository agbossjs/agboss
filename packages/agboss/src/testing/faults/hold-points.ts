/**
 * Named hold points (#484 AC5): places in a process where a test stops an operation and lets it go
 * when it chooses — the way to force the order of operations across processes without a sleep.
 * A point is armed (`arm`), the next operation that reaches it with a matching key waits there
 * (`reach`) and is announced (`onHeld`), and the test releases it (`release`). An unarmed point
 * lets every operation through at once. The registry is the process's own memory: each process
 * holds its own operations, and a test drives them over its control channel.
 */

/** Where in an operation a hold waits: before the store is asked, or after it answered. */
export enum HoldPhase {
  Before = "before",
  After = "after",
}

/** What to hold: a point, its phase, the key of the operation (absent: any), how many arrivals. */
export interface HoldRequest {
  /** The point's name: a `StoreHoldPoint`, or a step's point of the fixture application. */
  readonly point: string;
  /** Default `HoldPhase.Before`. */
  readonly phase?: HoldPhase;
  /** The operation's key (a lease's root execution, an effect's lease execution); absent: any. */
  readonly key?: string;
  /** How many arrivals it holds, each its own hold; default 1. */
  readonly times?: number;
}

/** An operation waiting at a hold point. */
export interface HeldOperation {
  /** What `release` takes. */
  readonly holdId: string;
  /** The `arm` call that held it. */
  readonly armId: string;
  readonly point: string;
  readonly phase: HoldPhase;
  readonly key: string | undefined;
}

/** An armed request and how many arrivals it still holds. */
interface Armed {
  readonly armId: string;
  readonly request: HoldRequest;
  left: number;
}

/** A held operation and how it goes on. */
interface Waiting {
  readonly operation: HeldOperation;
  readonly release: () => void;
}

/** Whether `armed` holds an arrival at `point` / `phase` with `key`. */
const matches = (armed: Armed, point: string, phase: HoldPhase, key: string | undefined): boolean =>
  armed.request.point === point &&
  (armed.request.phase ?? HoldPhase.Before) === phase &&
  (armed.request.key === undefined || armed.request.key === key);

/** Why a step's signal aborted, as an error. */
const reasonOf = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new Error("the step stopped");

/** A process's hold points: armed requests, the operations held at them, who hears of a hold. */
export class HoldPoints {
  readonly #armed: Armed[] = [];
  readonly #waiting = new Map<string, Waiting>();
  readonly #listeners = new Set<(operation: HeldOperation) => void>();
  #count = 0;

  /** Arms a hold; its id, for `disarm`. */
  arm(request: HoldRequest): string {
    const times = request.times ?? 1;
    if (!Number.isInteger(times) || times < 1)
      throw new RangeError(`a hold holds a whole number of arrivals from 1, got ${String(times)}`);
    this.#count += 1;
    const armId = `arm-${String(this.#count)}`;
    this.#armed.push({ armId, request, left: times });
    return armId;
  }

  /** Disarms a hold: the operations it holds already stay held until released. */
  disarm(armId: string): void {
    const at = this.#armed.findIndex((armed) => armed.armId === armId);
    if (at !== -1) this.#armed.splice(at, 1);
  }

  /** Lets a held operation go on; `false` when nothing waits under `holdId`. */
  release(holdId: string): boolean {
    const waiting = this.#waiting.get(holdId);
    if (waiting === undefined) return false;
    this.#waiting.delete(holdId);
    waiting.release();
    return true;
  }

  /** Disarms every hold and lets every held operation go on. */
  releaseAll(): void {
    this.#armed.splice(0);
    for (const holdId of [...this.#waiting.keys()]) this.release(holdId);
  }

  /** The operations held now, in the order they arrived. */
  get held(): readonly HeldOperation[] {
    return [...this.#waiting.values()].map((waiting) => waiting.operation);
  }

  /** Calls `listener` on every hold from now on; the returned function stops it. */
  onHeld(listener: (operation: HeldOperation) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * An operation at `point`: resolves at once unless an armed hold matches, else once released.
   * `signal` (a step's) ends the wait with its reason, as the step it belongs to stops.
   */
  reach(
    point: string,
    phase: HoldPhase,
    key: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const armed = this.#armed.find((candidate) => matches(candidate, point, phase, key));
    if (armed === undefined) return Promise.resolve();
    if (signal?.aborted === true) return Promise.reject(reasonOf(signal));
    armed.left -= 1;
    if (armed.left === 0) this.disarm(armed.armId);
    this.#count += 1;
    const operation = {
      holdId: `hold-${String(this.#count)}`,
      armId: armed.armId,
      point,
      phase,
      key,
    };
    return new Promise<void>((resolve, reject) => {
      this.#waiting.set(operation.holdId, { operation, release: resolve });
      signal?.addEventListener(
        "abort",
        () => {
          this.#waiting.delete(operation.holdId);
          reject(reasonOf(signal));
        },
        { once: true },
      );
      for (const listener of [...this.#listeners]) listener(operation);
    });
  }
}

/** The hold points of this process: what the fault pods and `withHoldPoints` use by default. */
export const processHoldPoints: HoldPoints = new HoldPoints();
