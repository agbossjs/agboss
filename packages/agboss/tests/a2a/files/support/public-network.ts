// #1244 — a simulated public network for the file fetch, IN this process: the name resolves to
// `PUBLIC`, `net.connect` is really made to a local server and the socket reports the address it was
// asked for as its remote one, `tls.connect` trusts the server's certificate. As an APM wrapper
// would, the patches are installed before the core's file modules are loaded (`NET_CONNECT` is taken
// when `a2a-file-connect.ts` loads), so a test file must import them only through `loadFileStack`.
import type * as DnsModule from "node:dns";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as NetModule from "node:net";
import type * as TlsModule from "node:tls";
import type { ScriptServer } from "./script-server.js";

export const PUBLIC = "93.184.216.34";

const load = createRequire(import.meta.url);
type Method = (this: unknown, ...args: unknown[]) => unknown;

/** What the code under test asked the network for. */
export interface Seen {
  /** The names `dns.lookup` was asked to resolve. */
  readonly lookups: string[];
  /** The options of every `net.connect`, as the code gave them. */
  readonly netOptions: Record<string, unknown>[];
  /** The options of every `tls.connect`, as the code gave them. */
  readonly tlsOptions: Record<string, unknown>[];
}

export interface PublicNetwork {
  readonly seen: Seen;
  /** The addresses a name resolves to (default `[PUBLIC]`). */
  answers: readonly string[];
  /** The remote address a socket reports; `undefined`: the address it was asked for. */
  claimed: string | undefined;
  /** Addresses whose connection never completes (a blackhole): the socket is made, never connected. */
  readonly stalled: Set<string>;
  /** A TLS socket that fails in the microtask after `tls.connect` made it (before any exchange listens). */
  failsTlsAtOnce: boolean;
  /** The local port a connection to an address really goes to (default: the server's). */
  readonly routes: Map<string, number>;
  /** Forgets what was seen (and every route, claim and stall): the next case starts clean. */
  readonly reset: () => void;
  readonly restore: () => void;
}

export function installPublicNetwork(server: ScriptServer): PublicNetwork {
  const dns = load("node:dns") as typeof DnsModule;
  const net = load("node:net") as typeof NetModule;
  const tls = load("node:tls") as typeof TlsModule;
  const originals = { lookup: dns.lookup, connect: net.connect, tlsConnect: tls.connect };
  const seen: Seen = { lookups: [], netOptions: [], tlsOptions: [] };
  const network: PublicNetwork = {
    seen,
    answers: [PUBLIC],
    claimed: undefined,
    routes: new Map(),
    stalled: new Set(),
    failsTlsAtOnce: false,
    reset: () => {
      network.answers = [PUBLIC];
      network.claimed = undefined;
      network.routes.clear();
      network.stalled.clear();
      network.failsTlsAtOnce = false;
      seen.lookups.length = 0;
      seen.netOptions.length = 0;
      seen.tlsOptions.length = 0;
      server.received.length = 0;
    },
    restore: () => {
      Reflect.set(dns, "lookup", originals.lookup);
      Reflect.set(net, "connect", originals.connect);
      Reflect.set(tls, "connect", originals.tlsConnect);
      syncBuiltinESMExports();
    },
  };
  Reflect.set(dns, "lookup", (name: string, options: { all?: boolean }, done: Method): void => {
    // the test's own servers listen on an IP literal: `listen` asks `dns.lookup` for it as well
    if (net.isIP(name) !== 0) {
      Reflect.apply(originals.lookup, dns, [name, options, done]);
      return;
    }
    seen.lookups.push(name);
    const list = network.answers.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
    queueMicrotask(() => {
      if (options.all === true) Reflect.apply(done, undefined, [null, list]);
      else Reflect.apply(done, undefined, [null, list[0]?.address, list[0]?.family]);
    });
  });
  Reflect.set(net, "connect", (options: Record<string, unknown>, ...rest: unknown[]) => {
    seen.netOptions.push(options);
    const asked = String(options.host);
    if (network.stalled.has(asked)) return new net.Socket();
    const socket = Reflect.apply(originals.connect, net, [
      { host: "127.0.0.1", port: network.routes.get(asked) ?? server.port },
      ...rest,
    ]) as NetModule.Socket;
    Object.defineProperty(socket, "remoteAddress", { get: () => network.claimed ?? asked });
    return socket;
  });
  Reflect.set(tls, "connect", (options: Record<string, unknown>, ...rest: unknown[]) => {
    seen.tlsOptions.push(options);
    const secure = Reflect.apply(originals.tlsConnect, tls, [
      { ...options, ca: [server.ca] },
      ...rest,
    ]) as TlsModule.TLSSocket;
    if (network.failsTlsAtOnce)
      queueMicrotask(() => {
        secure.emit("error", new Error("a TLS socket that failed at once"));
      });
    return secure;
  });
  syncBuiltinESMExports();
  return network;
}

/** Every export of the file fetch's modules, by name. */
export type FileStack = typeof import("../../../../src/a2a/files/a2a-file-fetch.js") &
  typeof import("../../../../src/a2a/files/a2a-file-transport.js") &
  typeof import("../../../../src/a2a/files/a2a-file-connect.js") &
  typeof import("../../../../src/a2a/files/a2a-file-exchange.js") &
  typeof import("../../../../src/a2a/files/a2a-file-address.js") &
  typeof import("../../../../src/a2a/files/a2a-file-span.js") &
  typeof import("../../../../src/infrastructure/clock.js") &
  typeof import("../../../../src/units/index.js");

/** The core's file modules, loaded now: after the patches, as a start-up patch would be. */
export async function loadFileStack(): Promise<FileStack> {
  const [fetch, transport, connect, exchange, address, span, clock, units] = await Promise.all([
    import("../../../../src/a2a/files/a2a-file-fetch.js"),
    import("../../../../src/a2a/files/a2a-file-transport.js"),
    import("../../../../src/a2a/files/a2a-file-connect.js"),
    import("../../../../src/a2a/files/a2a-file-exchange.js"),
    import("../../../../src/a2a/files/a2a-file-address.js"),
    import("../../../../src/a2a/files/a2a-file-span.js"),
    import("../../../../src/infrastructure/clock.js"),
    import("../../../../src/units/index.js"),
  ]);
  return {
    ...fetch,
    ...transport,
    ...connect,
    ...exchange,
    ...address,
    ...span,
    ...clock,
    ...units,
  };
}
