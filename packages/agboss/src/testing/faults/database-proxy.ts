import {
  createConnection,
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";

/**
 * The database's network, under a test's control (#484 scenario 8): a TCP proxy in the test's
 * process between one pod and its database. `freeze()` freezes every connection (nothing goes
 * either way, as a partition: the pod's queries hang), `drop()` cuts every connection and refuses
 * new ones (its queries fail), `reconnect()` lets traffic and new connections through again. One
 * proxy per pod, so one pod loses its database while the others keep theirs. `dropAfter(...)` (#1017)
 * cuts one link after the bytes that apply a write were forwarded: the database applies it, its
 * answer is lost.
 */

/** Where the proxy forwards to. */
export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

/** How the proxy treats traffic now. */
export enum ProxyState {
  Open = "open",
  /** Every connection frozen: nothing forwarded, nothing closed — a network that stopped answering. */
  Frozen = "frozen",
  /** Every connection cut, new ones refused. */
  Dropped = "dropped",
}

/** One proxied connection: the pod's side and the database's. */
interface Link {
  readonly client: Socket;
  readonly server: Socket;
  /** For each armed cut, how many of its patterns this link's client bytes matched so far. */
  readonly progress: Map<Cut, number>;
  isWatched: boolean;
}

/** What a client's bytes are matched against: a text or a regular expression, on the bytes as latin1. */
export type ByteMatch = string | RegExp;

/** An armed cut: the patterns a link's bytes must match in order; it cuts one link. */
interface Cut {
  readonly patterns: readonly ByteMatch[];
  /** How many more cuts follow this one, each matching only the last pattern (a retry's COMMIT). */
  readonly repeats: number;
  /** Shared by a cut and its repeats: the disarm of `dropAfterRepeated` clears it. */
  readonly armed: { value: boolean };
}

const matchesBytes = (pattern: ByteMatch, text: string): boolean =>
  typeof pattern === "string"
    ? text.includes(pattern)
    : new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, "")).test(text);

/** Stops forwarding either way: unpiped and paused, so no drain resumes it. */
function freezeLink(link: Link): void {
  link.client.unpipe(link.server);
  link.server.unpipe(link.client);
  link.client.pause();
  link.server.pause();
}

export class DatabaseProxy {
  readonly #links = new Set<Link>();
  readonly #cuts = new Set<Cut>();
  /** Database sides of cut links, ended and left to drain: closed with the proxy. */
  readonly #draining = new Set<Socket>();
  #server: Server | undefined;
  #state = ProxyState.Open;
  #cutsAfterWrite = 0;

  constructor(private readonly target: ProxyTarget) {}

  /** How many links `dropAfter` cut so far: a scenario checks its fault was really delivered. */
  get cutsAfterWrite(): number {
    return this.#cutsAfterWrite;
  }

  /** What it does with traffic now. */
  get state(): ProxyState {
    return this.#state;
  }

  /** Listens on 127.0.0.1 at a free port; resolves with that port. */
  async start(): Promise<number> {
    const server = createServer((client) => {
      this.#accept(client);
    });
    this.#server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return (server.address() as AddressInfo).port;
  }

  /** Freezes every connection: nothing is forwarded until `reconnect()`. */
  freeze(): void {
    if (this.#state !== ProxyState.Open) return;
    this.#state = ProxyState.Frozen;
    for (const link of this.#links) freezeLink(link);
  }

  /** Cuts every connection; new ones are refused until `reconnect()`. */
  drop(): void {
    this.#state = ProxyState.Dropped;
    for (const link of [...this.#links]) this.#cut(link);
  }

  /** Lets traffic and new connections through again. */
  reconnect(): void {
    const wasFrozen = this.#state === ProxyState.Frozen;
    this.#state = ProxyState.Open;
    if (wasFrozen) for (const link of this.#links) this.#flow(link);
  }

  /**
   * Cuts the next link whose client bytes matched every one of `patterns`, in order (one chunk may
   * match several): the bytes are forwarded first and the database's side is ended only after them,
   * so the database applies what it was asked and the client hears nothing of it — a COMMIT whose
   * answer is lost (#1017). A pattern matches within one chunk, as latin1 text. One link is cut;
   * the returned function disarms it.
   */
  dropAfter(...patterns: readonly ByteMatch[]): () => void {
    return this.dropAfterRepeated(1, ...patterns);
  }

  /**
   * `dropAfter`, `times` times over: the first cut is as `dropAfter`'s; each of the `times - 1`
   * after it cuts the next link — a retry's, on a new connection — whose client bytes match only
   * the last pattern (the COMMIT again). A commit whose answer is lost again and again: its
   * outcome stays unknown to a client that retries it (#1017). The returned function disarms
   * the cut that is armed and every one still to come.
   */
  dropAfterRepeated(times: number, ...patterns: readonly ByteMatch[]): () => void {
    if (!Number.isInteger(times) || times < 1)
      throw new RangeError(
        `a cut is repeated a whole number of times from 1, got ${String(times)}`,
      );
    const cut: Cut = { patterns, repeats: times - 1, armed: { value: true } };
    this.#cuts.add(cut);
    return () => {
      cut.armed.value = false;
      for (const armed of [...this.#cuts]) if (armed.armed === cut.armed) this.#cuts.delete(armed);
    };
  }

  /** Cuts every connection and stops listening. */
  async close(): Promise<void> {
    for (const link of [...this.#links]) this.#cut(link);
    for (const socket of this.#draining) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined)
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
  }

  #accept(client: Socket): void {
    if (this.#state === ProxyState.Dropped) {
      client.destroy();
      return;
    }
    const server = createConnection(this.target.port, this.target.host);
    const link: Link = { client, server, progress: new Map(), isWatched: false };
    this.#links.add(link);
    if (this.#state === ProxyState.Open) this.#flow(link);
    const cut = (): void => {
      this.#cut(link);
    };
    for (const socket of [client, server]) {
      socket.on("error", cut);
      socket.on("close", cut);
    }
  }

  /** Forwards either way, and watches the client's bytes for an armed cut. */
  #flow(link: Link): void {
    link.client.pipe(link.server);
    link.server.pipe(link.client);
    if (link.isWatched) return;
    link.isWatched = true;
    // after the pipe's own listener: the chunk is written to the database first
    link.client.on("data", (chunk: Buffer) => {
      this.#watch(link, chunk.toString("latin1"));
    });
  }

  #watch(link: Link, text: string): void {
    for (const cut of this.#cuts) {
      let matched = link.progress.get(cut) ?? 0;
      for (const pattern of cut.patterns.slice(matched)) {
        if (!matchesBytes(pattern, text)) break;
        matched += 1;
      }
      link.progress.set(cut, matched);
      if (matched < cut.patterns.length) continue;
      this.#cuts.delete(cut);
      const last = cut.patterns.at(-1);
      if (cut.repeats > 0 && cut.armed.value && last !== undefined)
        this.#cuts.add({ patterns: [last], repeats: cut.repeats - 1, armed: cut.armed });
      this.#cutAfterWrite(link);
      return;
    }
  }

  /** The client is cut at once; the database's side is ended after what was written to it. */
  #cutAfterWrite(link: Link): void {
    if (!this.#links.delete(link)) return;
    this.#cutsAfterWrite += 1;
    link.server.unpipe(link.client);
    link.client.unpipe(link.server);
    link.client.destroy();
    this.#draining.add(link.server);
    link.server.on("close", () => this.#draining.delete(link.server));
    link.server.end();
  }

  #cut(link: Link): void {
    if (!this.#links.delete(link)) return;
    link.client.destroy();
    link.server.destroy();
  }
}
