import { ExecutionLeaseLostError } from "../../../src/index.js";

/** Whether `promise` settled, either way (read it when asked). */
export function settledFlag(promise: Promise<unknown>): () => boolean {
  let isSettled = false;
  void promise.then(
    () => {
      isSettled = true;
    },
    () => {
      isSettled = true;
    },
  );
  return () => isSettled;
}

/** The hand-over's cause, when `error` is one. */
export function causeOf(error: unknown): unknown {
  return error instanceof ExecutionLeaseLostError ? error.cause : undefined;
}

/** Whether a store operation of the history is a release or a retirement of a lease. */
export const isGivingBack = (operation: string): boolean =>
  /lease\.(release|retire)/u.test(operation);
