/**
 * When a held lease is yielded (#333 PR 4, #471): while every caller of the tree waits for remote
 * children (`yieldWhile`) and no step of the tree runs — a sibling branch's step keeps the lease, and
 * a step that starts while it is yielded takes it back first. The yields and re-acquires run one at a
 * time, in order; `move(shouldYield)` does one.
 */
export class LeaseYields {
  /** The callers waiting for remote children in `yieldWhile`. */
  #waiting = 0;
  /** The steps of the tree running under the lease. */
  #running = 0;
  #moves: Promise<void> = Promise.resolve();

  constructor(private readonly move: (shouldYield: boolean) => Promise<void>) {}

  /** A step starts: the lease held (taken back first when it was yielded); the function leaves. */
  async enterStep(): Promise<() => void> {
    this.#running += 1;
    try {
      await this.settle();
    } catch (error) {
      this.#running -= 1;
      throw error;
    }
    let isLeft = false;
    return (): void => {
      if (isLeft) return;
      isLeft = true;
      this.#running -= 1;
      void this.settle().catch((): undefined => undefined);
    };
  }

  /** A caller waits for remote children: the lease yielded once nothing else holds it. */
  async startWaiting(): Promise<void> {
    this.#waiting += 1;
    await Promise.resolve();
    await this.settle();
  }

  /** The caller stopped waiting: with `isHandedOver` false, the lease taken back before it goes on. */
  async stopWaiting(isHandedOver: boolean): Promise<void> {
    this.#waiting -= 1;
    if (!isHandedOver) await this.settle();
  }

  /** The next move: yield when every caller waits and no step runs, else hold. */
  settle(): Promise<void> {
    const next = this.#moves.then(() => this.move(this.#waiting > 0 && this.#running === 0));
    this.#moves = next.catch((): undefined => undefined);
    return next;
  }
}

/**
 * One renewal or reclaim of a held lease at a time (#516): a renewal reads the lease when its turn
 * comes, so it never answers for a token a reclaim moved on meanwhile (which would read as lost).
 */
export class LeaseTurns {
  #turns: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.#turns.then(work);
    this.#turns = turn.catch((): undefined => undefined);
    return turn;
  }
}

/**
 * The outbound calls' attempts in flight under a lease (#508): its holder releases it only once
 * they settled — renewed on meanwhile — so no other instance takes a pending intent for gone while
 * its owner still sends. A lost lease waits for nothing: its taker's token proves the owner gone.
 */
export class LeaseAttempts {
  readonly #attempts = new Set<Promise<void>>();

  keep(attempt: Promise<unknown>): void {
    const settled = attempt.then(
      () => undefined,
      () => undefined,
    );
    this.#attempts.add(settled);
    void settled.then(() => {
      this.#attempts.delete(settled);
    });
  }

  /** Once every attempt kept settled, or `lost` aborted. */
  async settled(lost: AbortSignal): Promise<void> {
    const aborted = new Promise<void>((resolve) => {
      lost.addEventListener("abort", () => {
        resolve();
      });
    });
    while (this.#attempts.size > 0 && !lost.aborted)
      await Promise.race([Promise.all([...this.#attempts]), aborted]);
  }
}
