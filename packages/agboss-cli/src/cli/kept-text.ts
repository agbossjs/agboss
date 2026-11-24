import { StreamEventKind } from "@agboss/core";
import type { ExecutionStreamEvent } from "@agboss/core/internal";

/**
 * The text of the reply that is still the reply (#1123): what `onStream` told, minus every step it
 * retracted (`StreamEventKind.Discarded`). A terminal cannot unwrite what it printed, so this is what `agboss run`
 * knows about the screen: when it is not the run's output, the output is printed from the result.
 */
export class KeptText {
  readonly #steps = new Map<string, string>();

  /** Takes one event of the stream. */
  hear(event: ExecutionStreamEvent): void {
    if (event.kind === StreamEventKind.TextDelta) {
      const key = stepKey(event.step);
      this.#steps.set(key, (this.#steps.get(key) ?? "") + event.delta);
    }
    if (event.kind === StreamEventKind.Discarded) this.#steps.delete(stepKey(event.step));
  }

  /** The text of the steps that were not retracted, in the order they began. */
  text(): string {
    return [...this.#steps.values()].join("");
  }
}

const stepKey = (step: {
  readonly agent: string;
  readonly visit: number;
  readonly branch: string;
  readonly attempt: number;
}): string => `${step.agent}|${String(step.visit)}|${step.branch}|${String(step.attempt)}`;
