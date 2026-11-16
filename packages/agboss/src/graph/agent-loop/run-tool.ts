import { handedOverOf, recordedHandOver } from "../../app/handed-over.js";
import { HandOverSite } from "../../infrastructure/execution-audit-log.repository.js";
import type { AnyTool, ToolInvocationContext, ToolOutput } from "../../tools/index.js";
import { isRerankFailure } from "../nodes/knowledge.js";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Tool failures are recoverable: whatever went wrong, the model reads it as `Tool error: …`. */
export async function runTool(
  tool: AnyTool,
  args: unknown,
  context: ToolInvocationContext,
): Promise<ToolOutput<unknown>> {
  try {
    const output = await tool.invoke(args, context);
    // a reranking that must fail the step (#703) is no tool error the model reads
    if (output.kind === "error" && isRerankFailure(output.cause)) throw output.cause;
    return output;
  } catch (error) {
    if (isRerankFailure(error)) throw error;
    if (error && typeof error === "object" && "name" in error && error.name === "GraphInterrupt") {
      throw error;
    }
    // a hand-over (#471: a fenced write too) ends the loop before onToolEnd and the tally
    const handedOver = handedOverOf(error, context.signal);
    if (handedOver !== undefined) throw recordedHandOver(handedOver, HandOverSite.Tool);
    return { kind: "error", message: errorMessage(error), cause: error };
  }
}
