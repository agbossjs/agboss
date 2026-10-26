import { ExecutionContext, Tool, type ToolHandler } from "@agboss/core";
import { seconds } from "@agboss/core/units";
import { DeskA2AAgent } from "../a2a/desk.a2a-agent.js";
import { DeskCallDto, DeskReplyDto } from "../dtos/desk-call.dto.js";

/** Asks the help desk over A2A: the input and the output checked by the contract. */
@Tool({
  name: "ask-desk-tool",
  description: "Asks the help desk about a customer's order",
  input: DeskCallDto,
  output: DeskReplyDto,
  timeout: seconds(30),
  deps: [DeskA2AAgent, ExecutionContext],
})
export class AskDeskTool implements ToolHandler<DeskCallDto, DeskReplyDto> {
  constructor(
    private readonly deskA2AAgent: DeskA2AAgent,
    private readonly executionContext: ExecutionContext,
  ) {}

  run(call: DeskCallDto): Promise<DeskReplyDto> {
    // the call's signal: a cancel or the tool's timeout aborts the HTTP request
    return this.deskA2AAgent.execute(call, { signal: this.executionContext.signal });
  }
}
