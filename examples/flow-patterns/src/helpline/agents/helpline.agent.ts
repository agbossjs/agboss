import { Agent } from "agboss";
import { AskDeskTool } from "../tools/ask-desk.tool.js";

/** Answers a caller by asking the help desk, another application, over A2A. */
@Agent({
  name: "helpline-agent",
  description: "Answers a caller's question about an order through the help desk",
  prompt:
    "Ask the help desk with ask-desk-tool, passing the caller's id and question, then repeat its answer.",
  model: "moonshotai/kimi-k2.6",
  tools: [AskDeskTool],
  maxToolCalls: 2,
})
export class HelplineAgent {}
