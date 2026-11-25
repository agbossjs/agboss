import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The writes of an in-memory fenced effect (#500, #1317c): the in-memory store has no database
 * transaction, so a test's rows buffer their writes here — `onEffectCommit(write)` inside the work —
 * and they are applied, in order, once the effect's result is stored, and never when the work
 * throws. Internal: tests and the in-memory contract set; an application's own in-memory
 * repositories write directly.
 */

/** The buffer of one running effect. */
export interface EffectWrites {
  /** `work` with this buffer ambient. */
  run<TValue>(work: () => TValue): TValue;
  readonly writes: (() => void)[];
}

const ambient = new AsyncLocalStorage<EffectWrites>();

/** A new empty buffer. */
export function inEffectWrites(): EffectWrites {
  const writes: (() => void)[] = [];
  const buffer: EffectWrites = { writes, run: (work) => ambient.run(buffer, work) };
  return buffer;
}

/** Applies a stored effect's buffered writes, in order. */
export function appliedEffectWrites(buffer: EffectWrites): void {
  for (const write of buffer.writes) write();
}

/**
 * Applies `write` when the running in-memory effect commits (its result stored); at once when none
 * is running. Never when the work throws.
 */
export function onEffectCommit(write: () => void): void {
  const buffer = ambient.getStore();
  if (buffer === undefined) write();
  else buffer.writes.push(write);
}
