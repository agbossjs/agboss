import type { ExecutionStreamEvent, StreamStep } from "../../src/run/types.js";

const keyOf = (step: StreamStep): string =>
  `${step.branch}|${step.agent}|${String(step.visit)}|${String(step.attempt)}`;

/**
 * What a consumer that applies `discarded` shows: the deltas of every step that was not retracted,
 * joined in the order they came (#1006's invariant: this is the agent's reply).
 */
export function keptText(events: readonly ExecutionStreamEvent[]): string {
  const retracted = new Set(
    events.flatMap((event) => (event.kind === "discarded" ? [keyOf(event.step)] : [])),
  );
  return events
    .flatMap((event) =>
      event.kind === "textDelta" && !retracted.has(keyOf(event.step)) ? [event.delta] : [],
    )
    .join("");
}
