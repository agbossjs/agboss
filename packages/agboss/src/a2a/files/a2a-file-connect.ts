import type { Socket } from "node:net";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { ClientRequest } from "node:http";
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
 * `global-agent` all act through an agent, and this request has none: a `ClientRequest` with a
 * `createConnection` of its own. The connection is made in four steps, none of which sends a byte
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

/**
 * The TLS socket to `url`'s host: connected to the first of its allowed addresses that accepts
 * (a denied one anywhere among them refuses the name), checked, then secured. Nothing is sent
 * before the peer check. Registered as this module's own.
 */
export async function connectionTo(
  url: URL,
  signal: AbortSignal,
  resolve?: AddressLookup,
): Promise<TLSSocket> {
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
      return secure;
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
 * The `GET` of `url`: the connection first (guarded lookup, peer check, TLS), and only then a
 * `ClientRequest` that has no agent and that connection as its own — so a denied address never
 * constructs a request, and a replaced `ClientRequest` that adds an agent has no connection of its
 * own to make before it is refused (the request destroyed, the socket too: `ADDRESS_DENIED`).
 */
export async function requestTo(url: URL, signal: AbortSignal): Promise<FileRequest> {
  const secure = await connectionTo(url, signal);
  const request = new REQUEST({
    ...urlToHttpOptions(url),
    // a request with no agent expects `http:`; the TLS is `connectionTo`'s, and 443 is the Host's default
    protocol: "http:",
    defaultPort: 443,
    method: "GET",
    headers: { accept: "*/*" },
    signal,
    createConnection: () => secure,
  });
  if (Reflect.get(request, "agent") !== undefined) {
    request.destroy();
    secure.destroy();
    throw deniedError();
  }
  return { request, secure };
}

/** Whether `socket` is one `requestTo`'s connection made. */
export const isOwnSocket = (socket: object): boolean => OWN_SOCKETS.has(socket);
