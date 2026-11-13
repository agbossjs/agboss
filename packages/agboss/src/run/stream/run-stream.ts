import type { ExecutionStreamEvent } from "../types.js";

/**
 * The run's stream sink (#1004): what the caller's `onStream` is wrapped as and what lives in the
 * `RunContext`. No LangChain callback carries the stream — the sink is reached only by the code
 * that means to stream (the answering model call of an agent, an agent's tool call), so a model
 * call the framework makes for itself (a judge, a router, a detector, a compaction) is silent by
 * construction.
 */
export class RunStream {
  constructor(private readonly listener: (event: ExecutionStreamEvent) => void) {}

  /**
   * Hands one event to the listener. A listener that throws never fails the run or stops its stream
   * (its error is logged by the listener's own seam, #1008).
   */
  emit(event: ExecutionStreamEvent): void {
    try {
      this.listener(event);
    } catch {
      // the consumer's bug is the consumer's: the run goes on
    }
  }
}
