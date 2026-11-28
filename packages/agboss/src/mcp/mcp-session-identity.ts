import type { McpCaller } from "./mcp-service-helpers.js";

/**
 * Who an MCP session belongs to (#1319b): the WHOLE identity of the caller that opened it, compared
 * deeply and in no key order, so a caller with the same `tenantId` and other context values (a plan,
 * roles) is another caller.
 */

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** A stable form of plain data: keys sorted, `undefined` fields dropped; anything else is not plain data. */
function canonical(value: unknown): unknown {
  if (value instanceof Date) return { date: value.getTime() };
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    // Stryker disable next-line StringLiteral: the text of an error `sameValue` catches, never read
    if (!isPlain(value)) throw new TypeError("not plain data");
    return Object.keys(value)
      .sort()
      .flatMap((key) => {
        const field: unknown = Reflect.get(value, key);
        return field === undefined ? [] : [[key, canonical(field)]];
      });
  }
  if (typeof value === "function" || typeof value === "symbol")
    // Stryker disable next-line StringLiteral: the text of an error `sameValue` catches, never read
    throw new TypeError("not plain data");
  return value;
}

/** Whether `a` and `b` are one plain value; a value that is not plain data equals nothing (fail closed). */
function sameValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  } catch {
    return false;
  }
}

/** Whether `a` is the whole identity `b` was opened for: the peer, owner, tenant record and context values. */
export const isSameCaller = (a: McpCaller, b: McpCaller): boolean =>
  a.peer === b.peer &&
  a.ownerId === b.ownerId &&
  sameValue(a.tenant, b.tenant) &&
  sameValue(a.execution, b.execution);

/**
 * The caller as the session `id` owns it: one that names no owner is the session's own — a tenant's
 * key `mcp-session:<id>`, an anonymous caller `anonymous:<id>` — so only a client holding the id,
 * of that tenant, is the same caller. Never made from the connection. A caller with an owner or a
 * tenant keeps its identity as `authOwnerId` (none for a tenant's key): what a call's idempotency is
 * scoped by, across sessions. An anonymous caller is no one principal, so it has none: its calls
 * are scoped by its session's own owner.
 */
export const inSession = (caller: McpCaller, id: string): McpCaller => {
  if (caller.ownerId !== undefined || caller.peer !== undefined)
    return { ...caller, authOwnerId: caller.ownerId };
  if (caller.tenant === undefined) return { ...caller, ownerId: `anonymous:${id}` };
  return { ...caller, ownerId: `mcp-session:${id}`, authOwnerId: undefined };
};

/**
 * The owner that identifies the caller's calls (#1410 H1): the one it came with, before `inSession`
 * gave it a session's own — so a retry in a new session is the same call. An anonymous caller (no
 * tenant, owner or peer) keeps its session's owner: its calls repeat only within one session.
 */
export const stableOwnerOf = (caller: McpCaller): string | undefined =>
  "authOwnerId" in caller ? caller.authOwnerId : caller.ownerId;
