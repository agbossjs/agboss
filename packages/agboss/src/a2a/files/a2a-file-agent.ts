import type { Socket } from "node:net";
import { isIP } from "node:net";
import { Agent } from "node:https";
import type { ClientRequestArgs } from "node:http";
import { deniedError, guardedLookupOf, isDeniedAddress } from "./a2a-file-address.js";

/**
 * The addresses the guarded lookup answered for each connection the file agent made (#916). A
 * socket that is not here did not come through `FileAgent` — a monkey-patched `https.request`, a
 * proxying agent such as `global-agent`'s — and is never used.
 */
const ANSWERED = new WeakMap<object, Set<string>>();

/**
 * The file fetch's own agent (#916): its own pool, the guarded lookup on every connection, no proxy.
 * Each connection remembers which addresses the lookup answered, so `isExpectedPeer` can tell that
 * the socket is connected to one of them and not to a proxy standing in for the host.
 */
export class FileAgent extends Agent {
  override createConnection(
    options: ClientRequestArgs,
    callback?: Parameters<Agent["createConnection"]>[1],
  ): ReturnType<Agent["createConnection"]> {
    const answers = new Set<string>();
    const lookup = guardedLookupOf(undefined, (addresses) => {
      for (const address of addresses) answers.add(address);
    });
    const socket = super.createConnection({ ...options, lookup }, callback);
    if (socket) ANSWERED.set(socket, answers);
    return socket;
  }
}

/** An address as compared: no brackets, no zone, lower case, IPv4-mapped as the IPv4 it carries. */
const canonicalOf = (address: string): string =>
  address
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "")
    .toLowerCase()
    .replace(/^::ffff:(?=\d+\.)/, "");

/**
 * Whether a socket's remote address is one a file may be fetched from: not a denied address
 * (including the embedded-IPv4 forms), and one the guarded lookup answered for this connection — or
 * the IP literal itself when the url had one. A socket without answers (it skipped the file agent)
 * or one connected to another address (a proxy) is not.
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

/**
 * Checks the peer of a request's socket as soon as it is connected, before a byte of the request
 * is sent (the TLS handshake follows the TCP connect): a socket that is not to an expected peer is
 * destroyed with an `ADDRESS_DENIED` error, which the request reports. A path that skipped the
 * guarded lookup — whatever replaced the request's agent or connection — is caught here.
 */
export function verifyPeerOf(socket: Socket, host: string): void {
  const verify = (): void => {
    if (!isExpectedPeer(socket.remoteAddress, ANSWERED.get(socket), host))
      socket.destroy(deniedError());
  };
  if (socket.connecting) socket.once("connect", verify);
  else verify();
}
