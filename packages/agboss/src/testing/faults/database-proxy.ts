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
 * proxy per pod, so one pod loses its database while the others keep theirs.
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
}

/** Stops forwarding either way: unpiped and paused, so no drain resumes it. */
function freezeLink(link: Link): void {
  link.client.unpipe(link.server);
  link.server.unpipe(link.client);
  link.client.pause();
  link.server.pause();
}

/** Forwards either way. */
function flow(link: Link): void {
  link.client.pipe(link.server);
  link.server.pipe(link.client);
}

export class DatabaseProxy {
  readonly #links = new Set<Link>();
  #server: Server | undefined;
  #state = ProxyState.Open;

  constructor(private readonly target: ProxyTarget) {}

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
    if (wasFrozen) for (const link of this.#links) flow(link);
  }

  /** Cuts every connection and stops listening. */
  async close(): Promise<void> {
    for (const link of [...this.#links]) this.#cut(link);
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
    const link = { client, server };
    this.#links.add(link);
    if (this.#state === ProxyState.Open) flow(link);
    const cut = (): void => {
      this.#cut(link);
    };
    for (const socket of [client, server]) {
      socket.on("error", cut);
      socket.on("close", cut);
    }
  }

  #cut(link: Link): void {
    if (!this.#links.delete(link)) return;
    link.client.destroy();
    link.server.destroy();
  }
}
