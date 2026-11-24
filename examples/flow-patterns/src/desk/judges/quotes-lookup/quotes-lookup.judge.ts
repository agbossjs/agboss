import { Judge, JudgeVerdict, ToolCallStatus, toolCallsOf, type JudgeInput } from "@agboss/core";
import { PlainTextDto } from "@agboss/core/dto";
import { OrderStatusTool } from "../../tools/order-status.tool.js";

/**
 * The desk's quality gate, in code (#396): when the agent looked an order up, its answer names
 * that order — read from the visit's tool calls (`input.toolCalls`), never from the text alone.
 */
@Judge({
  name: "quotes-lookup-judge",
  description: "An answer after a lookup names the order looked up",
  output: PlainTextDto,
})
export class QuotesLookupJudge {
  judge({ output, toolCalls }: JudgeInput<PlainTextDto>): JudgeVerdict {
    const looked = toolCallsOf(OrderStatusTool, toolCalls).filter(
      (call) => call.status === ToolCallStatus.Succeeded,
    );
    const missing = looked.filter((call) => !output.text.includes(call.input.orderId));
    return missing.length === 0
      ? JudgeVerdict.passed({ metrics: { lookups: looked.length } })
      : JudgeVerdict.failed("name the order you looked up in the answer");
  }
}
