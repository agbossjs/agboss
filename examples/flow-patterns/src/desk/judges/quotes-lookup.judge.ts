import {
  DecidedBy,
  Judge,
  JudgeVerdict,
  ToolCallStatus,
  toolCallsOf,
  type JudgeHandler,
  type JudgeInput,
} from "agboss";
import { PlainTextDto } from "agboss/dto";
import { OrderStatusTool } from "../tools/order-status.tool.js";

/**
 * The desk's quality gate, in code (#396): when the agent looked an order up, its answer names
 * that order — read from the visit's tool calls (`input.toolCalls`), never from the text alone.
 */
@Judge({
  name: "quotes-lookup-judge",
  description: "An answer after a lookup names the order looked up",
  decidedBy: DecidedBy.Code,
  reply: PlainTextDto,
})
export class QuotesLookupJudge implements JudgeHandler<PlainTextDto> {
  judge({ reply, toolCalls }: JudgeInput<PlainTextDto>): Promise<JudgeVerdict> {
    const looked = toolCallsOf(OrderStatusTool, toolCalls).filter(
      (call) => call.status === ToolCallStatus.Succeeded,
    );
    const missing = looked.filter((call) => !reply.text.includes(call.input.orderId));
    return Promise.resolve(
      missing.length === 0
        ? JudgeVerdict.passed({ metrics: { lookups: looked.length } })
        : JudgeVerdict.failed({ reason: "name the order you looked up in the answer" }),
    );
  }
}
