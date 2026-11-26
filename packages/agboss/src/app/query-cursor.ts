import { createHash } from "node:crypto";

/**
 * A listing's cursor is bound to the query that made it (#1307e, L2): the store's own position
 * sealed with a hash of the query's scope and filters. A cursor reused with another tenant or
 * another filter is refused (`ValidationError.DtoInvalid` on `cursor`), never read silently as a
 * position that skips rows. The page size is not part of the hash: it may change between pages.
 */

/** A short digest of what a query selects (its scope and filters, never its page size). */
export const queryHashOf = (selects: unknown): string =>
  createHash("sha256").update(JSON.stringify(selects)).digest("base64url").slice(0, 16);

/** The cursor a caller is given: the store's position, tied to `hash`. */
export const sealedCursor = (storeCursor: string, hash: string): string =>
  Buffer.from(JSON.stringify({ c: storeCursor, h: hash })).toString("base64url");

/** What a given cursor opens to: the store's position, or the reason it is refused. */
export type OpenedCursor =
  | { readonly storeCursor: string; readonly problem?: never }
  | { readonly problem: string; readonly storeCursor?: never };

/** The store's position inside `cursor`, when `cursor` was made by a query with this `hash`. */
export function openedCursor(cursor: string, hash: string): OpenedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return { problem: "a cursor is the nextCursor of a page before, as it was given" };
  }
  const { c, h } = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    c?: unknown;
    h?: unknown;
  };
  if (typeof c !== "string" || typeof h !== "string")
    return { problem: "a cursor is the nextCursor of a page before, as it was given" };
  return h === hash
    ? { storeCursor: c }
    : {
        problem:
          "this cursor belongs to a query with other filters or another tenant: start again without it",
      };
}
