import type { FrameworkLog, LogSubject } from "../../infrastructure/logger.js";
import type { ExecutionStreamEvent } from "../types.js";

/**
 * The run's stream sink (#1004): what the caller's `onStream` is wrapped as and what lives in the
 * `RunContext`. No LangChain callback carries the stream — the sink is reached only by the code
 * that means to stream (the answering model call of an agent, an agent's tool call), so a model
 * call the framework makes for itself (a judge, a router, a detector, a compaction) is silent by
 * construction.
 */
export class RunStream {
  #reported = false;

  constructor(
    private readonly listener: (event: ExecutionStreamEvent) => void,
    private readonly log?: FrameworkLog,
    private readonly subject: LogSubject = {},
  ) {}

  /**
   * Hands one event to the listener. A listener that throws never fails the run or stops its stream:
   * it is logged (`stream.listener-failed`, Warn) once per run, with the run's ids, the error's
   * class and never the event (#1008).
   */
  emit(event: ExecutionStreamEvent): void {
    try {
      this.listener(event);
    } catch (error) {
      this.#report(error);
    }
  }

  #report(error: unknown): void {
    if (this.#reported) return;
    this.#reported = true;
    const kind = error instanceof Error ? error.name : typeof error;
    this.log?.warn(
      "stream.listener-failed",
      `the onStream listener threw (${kind}); the run goes on and its stream is still delivered - said once per run`,
      this.subject,
    );
  }
}
