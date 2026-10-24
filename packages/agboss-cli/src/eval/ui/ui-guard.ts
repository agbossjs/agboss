import { timingSafeEqual } from "node:crypto";

/**
 * Who a local UI answers (#397 PR 3, shared with `agboss hub ui`, #401 PR 6): the token it printed
 * (compared in constant time), a loopback `Host` of its own port (DNS rebinding), and for a form its
 * own pages' `Origin`.
 */

/** Whether a request names the printed token. */
export const isToken = (given: string | null, token: string): boolean =>
  given !== null &&
  given.length === token.length &&
  timingSafeEqual(Buffer.from(given), Buffer.from(token));

/** The origins a browser on this machine has for the server's port. */
const originsOf = (port: number): readonly string[] => [
  `127.0.0.1:${String(port)}`,
  `localhost:${String(port)}`,
];

/** Whether a request's `Host` is the server's own, on the loopback address. */
export const isOwnHost = (host: string | undefined, port: number): boolean =>
  host !== undefined && originsOf(port).includes(host.toLowerCase());

/** Whether a form comes from the server's own pages (no `Origin`: not a browser's cross-site post). */
export const isOwnOrigin = (origin: string | undefined, port: number): boolean =>
  origin === undefined || originsOf(port).some((own) => origin.toLowerCase() === `http://${own}`);
