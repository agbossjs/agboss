import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The business rows of a broken in-memory store (#1317c): `work` is handed no transaction, so the
 * store runs it with a buffer ambient and the test's rows write into it — applied at the store's
 * commit (`isImmediate` false) or as they come (`true`, a store whose rows leave its transaction).
 */
export class AmbientBuffer {
  readonly writes: (() => void)[] = [];

  constructor(private readonly isImmediate = false) {}

  onCommit(write: () => void): void {
    if (this.isImmediate) write();
    else this.writes.push(write);
  }
}

const ambient = new AsyncLocalStorage<AmbientBuffer>();

/** `work` with `buffer` ambient. */
export const withBuffer = <TValue>(buffer: AmbientBuffer, work: () => TValue): TValue =>
  ambient.run(buffer, work);

/** The running store's buffer: a row inserted outside a store's work is a test's bug. */
export function bufferOfWork(): AmbientBuffer {
  const found = ambient.getStore();
  if (found === undefined) throw new Error("a business row was inserted outside a store's work");
  return found;
}
