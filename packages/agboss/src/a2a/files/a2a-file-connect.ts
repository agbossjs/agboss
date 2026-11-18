import type { LookupFunction, Socket } from "node:net";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import {
  ADDRESS_DENIED,
  addressesOf,
  type AddressLookup,
  deniedError,
  hostOf,
  isDeniedAddress,
  unbracketed,
  withoutZone,
} from "./a2a-file-address.js";

/**
 * The file fetch's own connection (#916). It takes nothing of its behaviour from `node:http(s)`:
 * no agent (a replaced `https.Agent` class, `https.globalAgent`, `NODE_USE_ENV_PROXY` and
 * `global-agent` all act through one) and no `ClientRequest` (#1138: a replacement could hand the
 * request to an agent that looks the name up again and connects to its answer) — the request is the
 * fetch's own HTTP/1.1 exchange on this connection (`a2a-file-exchange.ts`). The connection is made
 * in four steps, none of which sends a byte before the peer is known: the guarded resolver names
 * the addresses, once (any denied one refuses the name); a raw TCP socket is connected to one of
 * them — the address itself as the host, and a `lookup` that answers only it, so even a `net.connect`
 * wrapper that puts a name back in makes no lookup of its own; its remote address is checked at
 * `connect`, before any byte, against the deny list and against the address connected to (else it
 * is destroyed); only then TLS starts on that socket (`servername` is the host, unless it is an IP
 * literal, and the certificate is checked for the host).
 *
 * What it does not do is probe whether `net`, `tls` or `ClientRequest` is patched: APM agents
 * (dd-trace, New Relic, OpenTelemetry) wrap exactly these, and a refusal would fail every file fetch
 * under them. The guarantee is the peer check, on the socket whatever made it.
 */

/** The functions the connection is made with, as the module found them when the core loaded. */
const NET_CONNECT = netConnect;
const TLS_CONNECT = tlsConnect;

/** An address as compared: no brackets, no zone, lower case, IPv4-mapped as the IPv4 it carries. */
const canonicalOf = (address: string): string =>
  withoutZone(unbracketed(address))
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
      // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent: an abort fires once, and `reject` settles the promise once
      { once: true },
    );
    promise.then(resolve, reject);
  });
}

/** A `net` lookup that answers `address` alone, whatever name it is asked for. */
const pinnedLookupOf =
  (address: string): LookupFunction =>
  (_name, options, done) => {
    const family = isIP(address);
    if (options.all === true) done(null, [{ address, family }]);
    else done(null, address, family);
  };

/** A raw TCP socket connected to `address`, its remote address checked before anything is sent. */
export function rawSocketTo(
  address: string,
  port: number,
  signal: AbortSignal,
  connectTimeout: number = CONNECT_TIMEOUT,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // an abort that already fired is never seen by a listener added now: no socket is opened
    if (signal.aborted) {
      reject(abortedError());
      return;
    }
    const socket = NET_CONNECT({ host: address, port, lookup: pinnedLookupOf(address) });
    socket.setTimeout(connectTimeout, () => {
      socket.destroy(new Error("the connection timed out"));
    });
    const onAbort = (): void => {
      socket.destroy(abortedError());
    };
    // Stryker disable next-line ObjectLiteral,BooleanLiteral: equivalent: an abort fires once, and a destroyed socket is destroyed again harmlessly
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
      // the address is an IP literal: it is the expected peer itself
      if (isExpectedPeer(socket.remoteAddress, undefined, address)) resolve(socket);
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
 * before the peer check.
 */
export async function connectionTo(
  url: URL,
  signal: AbortSignal,
  resolve?: AddressLookup,
): Promise<Connection> {
  const host = hostOf(url);
  const port = url.port === "" ? 443 : Number(url.port);
  if (port < 1) throw new Error("the file's url has no usable port");
  const addresses = isIP(host) !== 0 ? [host] : await racedWith(addressesOf(host, resolve), signal);
  let failure: unknown; // `addressesOf` answers one address at least, or fails
  for (const address of addresses) {
    // after an abort the loop does not go on to the next address (a failure of the one that was aborted ends here)
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
      // an error before the exchange listens (two microtask hops on) must not be an uncaught one:
      // the exchange's own listener takes over, and a close before a response is its failure
      secure.on("error", () => undefined);
      return { secure, address };
    } catch (error) {
      if (Reflect.get(Object(error), "code") === ADDRESS_DENIED) throw error;
      failure = error;
    }
  }
  throw failure;
}
