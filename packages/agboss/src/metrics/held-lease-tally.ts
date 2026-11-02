import type { HeldLeases } from "../app/execution-leases.js";

/**
 * How many tree leases one instance holds now (#485, `agboss.instance.leases.held`): a held lease
 * counts from its take until `until` aborts — released, or lost; one already over is not counted.
 */
export class HeldLeaseTally implements HeldLeases {
  #held = 0;

  get held(): number {
    return this.#held;
  }

  hold(until: AbortSignal): void {
    if (until.aborted) return;
    this.#held += 1;
    until.addEventListener(
      "abort",
      () => {
        this.#held -= 1;
      },
      { once: true },
    );
  }
}
