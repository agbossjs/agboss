import type { Socket } from "node:net";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { type Agent, ClientRequest } from "node:http";
import { urlToHttpOptions } from "node:url";
import {
  ADDRESS_DENIED,
  addressesOf,
  type AddressLookup,
  deniedError,
  isDeniedAddress,
} from "./a2a-file-address.js";

/**
 * The file fetch's own connection (#916). It takes nothing of its behaviour from a patchable
 * `https.Agent` — a replaced `https.Agent` class, `https.globalAgent`, `NODE_USE_ENV_PROXY` and
 * `global-agent` all act through an agent, and this request has only its own (#1138): an
 * agent-like object that hands it the one connection made here, pinned to its checked address. The
 * connection is made in four steps, none of which sends a byte
 * before the peer is known: the guarded resolver names the addresses (any denied one refuses the
 * name); a raw TCP socket is connected to one of them; its remote address is checked against the
 * deny list and against the address connected to; only then TLS starts on that socket
 * (`servername` is the host, unless it is an IP literal) and the request goes over it.
 *
 * What it does not do is probe whether `net`, `tls` or `ClientRequest` is patched: APM agents
 * (dd-trace, New Relic, OpenTelemetry) wrap exactly these, and a refusal would fail every file fetch
 * under them. The guarantee is the peer check, on the socket whatever made it.
 */

/** The functions the connection is made with, as the module found them when the core loaded. */
const NET_CONNECT = netConnect;
const TLS_CONNECT = tlsConnect;
const REQUEST = ClientRequest;

/** The TLS sockets this module made: a request on any other socket is refused. */
const OWN_SOCKETS = new WeakSet<object>();

/** An address as compared: no brackets, no zone, lower case, IPv4-mapped as the IPv4 it carries. */
const canonicalOf = (address: string): string =>
  address
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase()
    .replace(/^::ffff:(?=\d+\.)/, "");

/**
 * Whether a socket's remote address is one a file may be fetched from: not a denied address
 * (including the embedded-IPv4 forms), and one of the addresses the connection was made to — or the
 * IP literal itself when the url had one. A socket without such addresses or connected to another
 * address (a proxy) is not.
 */
export function isExpectedPeer(
  remote: string | undefined,
  answers: ReadonlySet<string> | undefined,
  host: string,
): boolean {
  if (remote === undefined || isDeniedAddress(remote)) return false;
  const expected = isIP(host) !== 0 ? new Set([host]) : answers;
  if (expected === undefined) return false;
  return [...expected].some((address) => canonicalOf(address) === canonicalOf(remote));
}

/** How long one TCP connection may take; the fetch's own deadline (the signal) is the tighter bound. */
const CONNECT_TIMEOUT = 10_000;

/** Read on each call: TypeScript cannot narrow an abort that happens while a promise is awaited. */
const isAborted = (signal: AbortSignal): boolean => signal.aborted;

const abortedError = (): Error => new Error("the file fetch was aborted");

/** `promise`, or a rejection as soon as `signal` aborts (a resolver that ignores it cannot hold the fetch). */
function racedWith<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) reject(abortedError());
    signal.addEventListener(
      "abort",
      () => {
        reject(abortedError());
      },
      { once: true },
    );
    promise.then(resolve, reject);
  });
}

/** A raw TCP socket connected to `address`, its remote address checked before anything is sent. */
export function rawSocketTo(address: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // an abort that already fired is never seen by a listener added now: no socket is opened
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const socket = NET_CONNECT({ host: address, port });
    socket.setTimeout(CONNECT_TIMEOUT, () => {
      socket.destroy(new Error("the connection timed out"));
    });
    const onAbort = (): void => {
      socket.destroy(abortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const onError = (error: Error): void => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      signal.removeEventListener("abort", onAbort);
      socket.off("error", onError);
      socket.setTimeout(0);
      if (isExpectedPeer(socket.remoteAddress, new Set([address]), address)) resolve(socket);
      else {
        socket.destroy();
        reject(deniedError());
      }
    });
  });
}

/** A TLS socket this module made, and the allowed address its TCP connection went to. */
export interface Connection {
  readonly secure: TLSSocket;
  readonly address: string;
}

/**
 * The TLS socket to `url`'s host: connected to the first of its allowed addresses that accepts
 * (a denied one anywhere among them refuses the name), checked, then secured. Nothing is sent
 * before the peer check. Registered as this module's own.
 */
export async function connectionTo(
  url: URL,
  signal: AbortSignal,
  resolve?: AddressLookup,
): Promise<Connection> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port === "" ? 443 : Number(url.port);
  const addresses = isIP(host) !== 0 ? [host] : await racedWith(addressesOf(host, resolve), signal);
  let failure: unknown = new Error("the file's host has no address");
  for (const address of addresses) {
    // after an abort the loop does not go on to the next address
    if (signal.aborted) throw abortedError();
    if (isDeniedAddress(address)) throw deniedError();
    try {
      const raw = await rawSocketTo(address, port, signal);
      // a TLS socket made on an existing socket has no SNI unless it is given (an IP literal cannot be one)
      const secure = TLS_CONNECT({
        socket: raw,
        host,
        ...(isIP(host) === 0 ? { servername: host } : {}),
      });
      OWN_SOCKETS.add(secure);
      return { secure, address };
    } catch (error) {
      if (Reflect.get(Object(error), "code") === ADDRESS_DENIED || isAborted(signal)) throw error;
      failure = error;
    }
  }
  throw failure;
}

/** A request and the TLS socket it was made over (to destroy when the request is refused). */
export interface FileRequest {
  readonly request: ClientRequest;
  readonly secure: TLSSocket;
}

/**
 * The request's own agent (#1138): an agent-like object, not an `http.Agent` (so a replaced
 * `http.Agent` class takes no part), that hands the request the one TLS socket `connectionTo` made.
 * It keeps no pool (`keepAlive` off, no socket limit: Node sends `Connection: close` and ends the
 * socket with the response); a request destroyed before its socket is assigned fails with an
 * error, whose handler destroys the socket (`httpsFileTransport`).
 */
function pinnedAgentOf(secure: TLSSocket): object {
  return {
    protocol: "http:",
    defaultPort: 443,
    keepAlive: false,
    maxSockets: Number.POSITIVE_INFINITY,
    addRequest: (request: ClientRequest) => {
      request.onSocket(secure);
    },
  };
}

/**
 * Options a connector other than the pinned agent cannot use to reach another peer (#1138): a
 * replaced `ClientRequest` that drops the agent and `createConnection` (Node then falls back to
 * `http.globalAgent`) or assigns another agent hands these to that agent's `net.connect`. The
 * host is the address already checked (no lookup at all), `lookup` answers only that address, and
 * `localAddress` is no IP, so `net.connect` throws before it opens anything — inside the request's
 * constructor, refused below. The pinned agent reads none of them (the Host header is the url's).
 */
const pinnedOptionsOf = (address: string): Record<string, unknown> => ({
  hostname: address,
  lookup: (_name: string, options: unknown, done: (...answer: unknown[]) => void) => {
    const family = isIP(address);
    if (Reflect.get(Object(options), "all") === true) done(null, [{ address, family }]);
    else done(null, address, family);
  },
  localAddress: "pinned-connection-only",
});

/**
 * Refuses a request that is not on the pinned agent (#1138). Its agent may have started a
 * connection of its own: it is never handed back to that agent's pool (a request destroyed
 * before its socket is assigned frees that socket into the pool, still connecting), so the
 * request is left alone until its socket comes and both are destroyed then. Nothing else destroys
 * it before that: the fetch's signal is not the request's (`abortedOnSignal`).
 */
function refusedForeign(request: ClientRequest, secure: TLSSocket): Error {
  secure.destroy();
  request.on("error", () => undefined);
  request.once("socket", (socket) => {
    socket.destroy();
    request.destroy();
  });
  return deniedError();
}

/**
 * The `GET` of `url`: the connection first (guarded lookup, peer check, TLS), and only then a
 * `ClientRequest` on the pinned agent, which hands it that connection — so a denied address never
 * constructs a request. A replaced `ClientRequest` that puts the request on another agent is
 * refused (`ADDRESS_DENIED`): the options give that agent no peer but the checked address and make
 * `net.connect` throw before it connects; one that also strips them reaches only the checked
 * address, and its socket is destroyed when it is assigned, before a byte. A replacement that sets
 * the url's name back makes its agent look the name up again (no connect: the socket is assigned,
 * and destroyed, before a lookup answers).
 */
export async function requestTo(url: URL, signal: AbortSignal): Promise<FileRequest> {
  const { secure, address } = await connectionTo(url, signal);
  // every failure from here on destroys the TLS socket made above: it is connected, its handshake
  // has started and nothing else holds it (the process would stay alive on it)
  const agent = pinnedAgentOf(secure);
  let request: ClientRequest;
  try {
    request = new REQUEST({
      ...urlToHttpOptions(url),
      ...pinnedOptionsOf(address),
      // a request on an `http:` agent expects `http:`; the TLS is `connectionTo`'s, and 443 is the Host's default
      protocol: "http:",
      defaultPort: 443,
      method: "GET",
      headers: { accept: "*/*", host: url.host },
      agent: agent as Agent,
      // kept, so a replacement that drops only the agent stays on this connection (and is refused)
      createConnection: () => secure,
    });
  } catch {
    // a constructor that throws (another agent's `net.connect` refusing the pinned options, or an
    // agent that does not take them, `ERR_INVALID_PROTOCOL`) is a request that is not ours
    secure.destroy();
    throw deniedError();
  }
  if (Reflect.get(request, "agent") !== agent) throw refusedForeign(request, secure);
  abortedOnSignal(request, signal);
  return { request, secure };
}

/** `AbortError`, as a request given a `signal` fails with it (`error.type` `ABORT_ERR` on the span). */
const requestAbortedError = (): Error =>
  Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });

/**
 * The fetch's signal destroys the request — only once it is known to be on the pinned agent: a
 * request destroyed before its socket is assigned would hand another agent's socket to its pool.
 */
function abortedOnSignal(request: ClientRequest, signal: AbortSignal): void {
  const onAbort = (): void => {
    request.destroy(requestAbortedError());
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  request.once("close", () => {
    signal.removeEventListener("abort", onAbort);
  });
}

/** Whether `socket` is one `requestTo`'s connection made. */
export const isOwnSocket = (socket: object): boolean => OWN_SOCKETS.has(socket);
