/**
 * The fetches of files by `url` a listener has in flight (#904 item 6): the same file of the same
 * message — one tenant, owner, `messageId`, skill, place and url — sent again while its first fetch
 * runs joins that fetch instead of fetching it again, so concurrent duplicates of one message fetch
 * each url once on an instance. Admission still runs before the `messageId` is deduplicated: across
 * instances each one fetches at most once, and a resend after the fetch ended (its task waiting to
 * start, no store keeping its files) fetches again — every fetch bounded by the skill's limits.
 *
 * A request that ends leaves the fetch; the fetch is aborted only once every request that joined
 * it has ended. An entry lives as long as its fetch runs: nothing is kept after it settles.
 */

/** What one fetch of a file is keyed by. */
export interface FileFetchKey {
  readonly tenantId: string;
  readonly ownerId: string | undefined;
  readonly messageId: string;
  readonly skill: string;
  /** The file's place among the message's file parts. */
  readonly index: number;
  readonly url: string;
}

/** One fetch in flight: its bytes, how many requests wait for it, what the last one to leave does. */
interface InFlight {
  readonly bytes: Promise<Uint8Array>;
  waiting: number;
  /** The fetch aborted and forgotten: a request that comes later starts its own. */
  readonly abandon: () => void;
}

const textOf = (key: FileFetchKey): string =>
  JSON.stringify([key.tenantId, key.ownerId ?? null, key.messageId, key.skill, key.index, key.url]);

/** A request's wait for a shared fetch: its bytes, or `whenLeft`'s error once the request ended. */
function waitFor(
  flight: InFlight,
  signal: AbortSignal,
  whenLeft: () => Error,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const leave = () => {
      flight.waiting -= 1;
      if (flight.waiting === 0) flight.abandon();
      reject(whenLeft());
    };
    if (signal.aborted) {
      leave();
      return;
    }
    signal.addEventListener("abort", leave, { once: true });
    flight.bytes.then(
      (bytes) => {
        signal.removeEventListener("abort", leave);
        resolve(bytes);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", leave);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** A listener's fetches in flight. */
export class FileFetches {
  readonly #inFlight = new Map<string, InFlight>();

  /**
   * The bytes of the file `key` names: from the fetch in flight for it, else from `fetch` started
   * now with a signal of its own (aborted once every request waiting for it has ended).
   */
  bytesOf(
    key: FileFetchKey,
    signal: AbortSignal,
    fetch: (signal: AbortSignal) => Promise<Uint8Array>,
    whenLeft: () => Error,
  ): Promise<Uint8Array> {
    const text = textOf(key);
    let flight = this.#inFlight.get(text);
    if (flight === undefined) {
      const abort = new AbortController();
      const bytes = fetch(abort.signal);
      const forget = () => {
        if (this.#inFlight.get(text) === started) this.#inFlight.delete(text);
      };
      const started: InFlight = {
        bytes,
        waiting: 0,
        abandon: () => {
          forget();
          abort.abort();
        },
      };
      this.#inFlight.set(text, started);
      bytes.then(forget, forget);
      flight = started;
    }
    flight.waiting += 1;
    return waitFor(flight, signal, whenLeft);
  }

  /** How many requests wait for fetches in flight. */
  get waiting(): number {
    return [...this.#inFlight.values()].reduce((total, flight) => total + flight.waiting, 0);
  }
}
