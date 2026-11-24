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
    if (!isPlain(value)) throw new TypeError("not plain data");
    const entries = Object.entries(value).filter(([, field]) => field !== undefined);
    return entries
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, field]) => [key, canonical(field)]);
  }
  if (typeof value === "function" || typeof value === "symbol")
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
