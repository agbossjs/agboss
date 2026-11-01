import { AGBossError } from "../../../src/core/errors.js";
import { Text } from "../../../src/dto/index.js";

/**
 * #634 — what the paid steps read and give, and what they did: every action writes it into
 * `paidSteps.ran`, so a test sees which steps ran past the budget; `paidSteps.charge` is what an
 * overspend costs (above every test budget by default).
 */

export class OrderDto {
  @Text({ prompt: "the order's id" })
  orderId!: string;
}

export class OrderNoteDto {
  @Text({ prompt: "the note" })
  note!: string;
}

/** The order was declined after its paid check: a domain error a side path takes. */
export class OrderDeclinedError extends AGBossError {
  static override readonly code: string = "test.order-declined";
}

/** What the steps did, in order; what an overspend costs; the hold the test lets go. */
export const paidSteps = {
  ran: [] as string[],
  /** Every execution started, by its workflow's name. */
  started: [] as string[],
  charge: 150,
  held: undefined as Promise<void> | undefined,
};

/** Holds `hold-order-action` until the returned function is called. */
export function holdOrders(): () => void {
  let release: () => void = () => undefined;
  paidSteps.held = new Promise((resolve) => {
    release = resolve;
  });
  return release;
}

export function resetPaidSteps(): void {
  paidSteps.ran.length = 0;
  paidSteps.started.length = 0;
  paidSteps.charge = 150;
  paidSteps.held = undefined;
}
