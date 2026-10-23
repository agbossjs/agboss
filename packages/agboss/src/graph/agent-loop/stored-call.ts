import { meshLimitBodyOf } from "../../mesh/mesh-wire.js";
import type { ToolOutput } from "../../tools/index.js";
import type { StoredToolCall, ToolTask } from "./state.js";
import type { ToolCallStop } from "./tool-stops.js";

/** How a guarded call ended, as far as the stored call needs it. */
export interface EndedToolCall {
  /** What the tool gave; none when it was refused, answered by an interceptor or stopped. */
  readonly output?: ToolOutput<unknown>;
  /** How an interceptor stopped it (#384). */
  readonly stop?: ToolCallStop;
}

/**
 * A finished call as the loop stores it, with the stop of an interceptor that stopped it (#384) and
 * the mesh limit its tool met (#398) — plain data, so a restart fails the step the same way.
 */
export function storedCallOf(
  task: ToolTask,
  content: string,
  ended: EndedToolCall,
): StoredToolCall {
  const { stop, output } = ended;
  const meshLimit = meshLimitBodyOf(output?.kind === "error" ? output.cause : undefined);
  return {
    callId: task.callId,
    tool: task.tool,
    content,
    ...(stop === undefined ? {} : { stop }),
    ...(meshLimit === undefined ? {} : { meshLimit }),
  };
}
