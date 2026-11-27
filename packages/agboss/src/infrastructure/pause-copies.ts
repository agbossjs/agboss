import type { PauseTrailEntry } from "../channels/pause-contexts.js";
import { copyOf, copyOfOptional } from "./instants.js";
import type { PauseNotice } from "./pause-notices.js";
import type { PauseFirstClose, PauseRecord } from "./pause-record.js";

/**
 * Copies of what a store holds, with fresh `Date`s (#1307, G3): a `Date` is mutable, so a record or a
 * notice a store hands out, or takes in, that shares an instance with the store's own state would let
 * a caller's `setTime` move a stored deadline — and the instance a compare-and-set reads. The
 * in-memory store copies at every boundary; the surfaces user code sees copy again (`copyOf`).
 */

/** One entry of a chain of custody with its times new `Date`s. */
export const copiedTrailEntry = (entry: PauseTrailEntry): PauseTrailEntry => ({
  ...entry,
  at: copyOf(entry.at),
  ...(entry.expiresAt === undefined ? {} : { expiresAt: copyOf(entry.expiresAt) }),
});

/** A chain of custody with every time of it a new `Date`. */
export const copiedTrail = (trail: readonly PauseTrailEntry[]): readonly PauseTrailEntry[] =>
  trail.map(copiedTrailEntry);

const firstCloseCopyOf = (first: PauseFirstClose): PauseFirstClose => ({
  ...first,
  resolvedAt: copyOf(first.resolvedAt),
});

/** The pause with every time of it a new `Date` (what is not a time is shared: it is never mutated). */
export const copiedPause = (pause: PauseRecord): PauseRecord => ({
  ...pause,
  askedAt: copyOf(pause.askedAt),
  firstAskedAt: copyOf(pause.firstAskedAt),
  trail: copiedTrail(pause.trail),
  ...(pause.maxExpiresAt === undefined ? {} : { maxExpiresAt: copyOf(pause.maxExpiresAt) }),
  ...(pause.resolvedAt === undefined ? {} : { resolvedAt: copyOf(pause.resolvedAt) }),
  ...(pause.expiresAt === undefined ? {} : { expiresAt: copyOf(pause.expiresAt) }),
  ...(pause.remindAt === undefined ? {} : { remindAt: copyOf(pause.remindAt) }),
  ...(pause.boundAt === undefined ? {} : { boundAt: copyOf(pause.boundAt) }),
  ...(pause.closedFirst === undefined ? {} : { closedFirst: firstCloseCopyOf(pause.closedFirst) }),
});

/** The notice with every time of it a new `Date`. */
export const copiedNotice = <N extends Omit<PauseNotice, "seq">>(notice: N): N => ({
  ...notice,
  writtenAt: copyOf(notice.writtenAt),
  ...(notice.closedAt === undefined ? {} : { closedAt: copyOfOptional(notice.closedAt) }),
  ...(notice.expiresAt === undefined ? {} : { expiresAt: copyOfOptional(notice.expiresAt) }),
  ...(notice.previousExpiresAt === undefined
    ? {}
    : { previousExpiresAt: copyOfOptional(notice.previousExpiresAt) }),
});
