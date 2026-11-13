import type { Socket } from "node:net";
import { connect as netConnect, isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { ClientRequest } from "node:http";
import { PassThrough } from "node:stream";
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
 * (`servername` is the host) and the request goes over it.
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

const sourceOf = (frame: string): string =>
  frame
    .replace(/^\s*at\s+/, "")
    .replace(/^.*\(/, "")
    .replace(/\)$/, "")
    .replace(/:\d+:\d+$/, "");

/** Whether the frames, from the throw down to this file (`here`), are all Node's own. */
function isNodeBelow(stack: string, here: string): boolean {
  for (const frame of stack.split("\n").slice(1)) {
    const source = sourceOf(frame);
    if (source === here) return true;
    if (!source.startsWith("node:") && source !== "<anonymous>") return false;
  }
  return false;
}

/**
 * Whether `call` runs Node's own code and nothing else down to this module: it must throw `code`
 * synchronously, and every frame between the throw and this file must be a `node:` frame. A
 * replacement of the function (or of a method it calls) puts its own frame in between.
 */
function isGenuine(call: () => unknown, code: string): boolean {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = Infinity;
  try {
    const here = sourceOf((new Error().stack ?? "").split("\n")[1] ?? "");
    try {
      call();
    } catch (error) {
      return (
        error instanceof Error &&
        Reflect.get(error, "code") === code &&
        isNodeBelow(error.stack ?? "", here)
      );
    }
    return false;
  } finally {
    Error.stackTraceLimit = limit;
  }
}

/** Whether what the connection is made with is Node's own, not patched (probed on every call). */
export const isUnpatched = (): boolean =>
  isGenuine(() => NET_CONNECT({ host: "127.0.0.1", port: -1 }), "ERR_SOCKET_BAD_PORT") &&
  isGenuine(() => TLS_CONNECT({ host: "127.0.0.1", port: -1 }), "ERR_SOCKET_BAD_PORT") &&
  isGenuine(() => new REQUEST({ protocol: "ftp:" }), "ERR_INVALID_PROTOCOL");

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
      const secure = TLS_CONNECT({ socket: raw, host });
      OWN_SOCKETS.add(secure);
      return secure;
    } catch (error) {
      if (Reflect.get(Object(error), "code") === ADDRESS_DENIED || isAborted(signal)) throw error;
      failure = error;
    }
  }
  throw failure;
}

/**
 * The `GET` of `url`, a `ClientRequest` with no agent and `connectionTo` as its connection. Refused
 * (`ADDRESS_DENIED`, nothing connected) when `net`, `tls` or `ClientRequest` is patched.
 */
export function requestTo(url: URL, signal: AbortSignal): ClientRequest {
  if (!isUnpatched()) throw deniedError();
  return new REQUEST({
    ...urlToHttpOptions(url),
    // a request with no agent expects `http:`; the TLS is `connectionTo`'s, and 443 is the Host's default
    protocol: "http:",
    defaultPort: 443,
    method: "GET",
    headers: { accept: "*/*" },
    signal,
    createConnection: (_options, done) => {
      connectionTo(url, signal).then(
        (socket) => {
          done(null, socket);
        },
        (error: unknown) => {
          done(error instanceof Error ? error : new Error(String(error)), new PassThrough());
        },
      );
      return undefined;
    },
  });
}

/** Whether `socket` is one `requestTo`'s connection made. */
export const isOwnSocket = (socket: object): boolean => OWN_SOCKETS.has(socket);
