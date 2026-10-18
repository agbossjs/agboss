import type { GatePass } from "./gate-pass.js";
import type { QueueTicket, TenantFairQueue } from "./tenant-fair-queue.js";

/** A call asking for room: its tenant and the signal that ends its wait. */
export interface GateTicket extends QueueTicket {
  readonly signal: AbortSignal | undefined;
}

/** A call waiting in a provider's queue: how it is let in or failed, and whether it has left. */
export interface Waiter extends GateTicket {
  readonly admit: (pass: GatePass) => void;
  readonly fail: (reason: Error) => void;
  /** Whether it left the queue (admitted, failed or cancelled). */
  readonly isSettled: () => boolean;
}

/** Why a signal ended a wait: its reason (`app.cancel` gives a `ExecutionCancelledError`). */
const abortErrorOf = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException("aborted", "AbortError");

/**
 * The ticket's call waiting in `queue` until the gate admits it; its signal takes it out of the
 * queue at once and rejects with the signal's reason. `changed` runs when it joins or leaves.
 */
export function waitInQueue(
  queue: TenantFairQueue<Waiter>,
  ticket: GateTicket,
  changed: () => void,
): Promise<GatePass> {
  return new Promise<GatePass>((resolve, reject) => {
    const { signal } = ticket;
    if (signal?.aborted === true) {
      reject(abortErrorOf(signal));
      return;
    }
    let settled = false;
    const leave = (): void => {
      settled = true;
      signal?.removeEventListener("abort", cancel);
    };
    const waiter: Waiter = {
      ...ticket,
      admit: (pass) => {
        leave();
        resolve(pass);
      },
      fail: (reason) => {
        leave();
        reject(reason);
      },
      isSettled: () => settled,
    };
    const cancel = (): void => {
      queue.remove(waiter);
      if (signal !== undefined) waiter.fail(abortErrorOf(signal));
      changed();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    queue.add(waiter);
    changed();
  });
}
