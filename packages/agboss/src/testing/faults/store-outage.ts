/**
 * A process's store outage (#484 scenario 8 on a store with no network: SQLite): while it lasts,
 * every operation of a held store either fails at once, as a refused connection does
 * (`StoreOutageMode.Refuse`), or waits until it ends, as a stalled connection does
 * (`StoreOutageMode.Hang`). A store reached over TCP is cut by the fault suite's database proxy
 * instead, for real.
 */

/** How the store is out. */
export enum StoreOutageMode {
  /** Every operation fails at once with `StoreOutageError`. */
  Refuse = "refuse",
  /** Every operation waits until the outage ends, then goes on. */
  Hang = "hang",
}

/** A held store's operation during a `Refuse` outage. */
export class StoreOutageError extends Error {
  override name = "StoreOutageError";

  constructor(operation: string) {
    super(`the store is unreachable (a fault test's outage): ${operation} was not sent`);
  }
}

/** The outage of one process's held stores: none, or one mode until it ends. */
export class StoreOutage {
  #mode: StoreOutageMode | undefined;
  #ended: { readonly promise: Promise<void>; readonly end: () => void } | undefined;

  /** The current mode; `undefined` while the store is reachable. */
  get mode(): StoreOutageMode | undefined {
    return this.#mode;
  }

  /** The store goes out (a second call changes the mode). */
  begin(mode: StoreOutageMode): void {
    this.#mode = mode;
    if (this.#ended !== undefined) return;
    let end = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      end = resolve;
    });
    this.#ended = { promise, end };
  }

  /** The store is back: the waiting operations go on. */
  end(): void {
    this.#mode = undefined;
    const ended = this.#ended;
    this.#ended = undefined;
    ended?.end();
  }

  /** Resolves when the operation may go to the store; rejects during a `Refuse` outage. */
  async passed(operation: string): Promise<void> {
    while (this.#mode !== undefined) {
      if (this.#mode === StoreOutageMode.Refuse) throw new StoreOutageError(operation);
      await this.#ended?.promise;
    }
  }
}
