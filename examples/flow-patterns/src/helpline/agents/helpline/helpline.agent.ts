import { Agent } from "@agboss/core";
import { ReadPolicyTool } from "../../mcp/read-policy.mcp.js";
import { AskDeskTool } from "../../tools/ask-desk.tool.js";

/**
 * Answers a caller by asking the help desk, another application, over A2A, and by reading the
 * customer policies through an MCP server.
 */
@Agent({
  name: "helpline-agent",
  description: "Answers a caller's question about an order through the help desk",
  prompt:
    "Ask the help desk with ask-desk-tool, passing the caller's id and question, then repeat its answer. For returns or shipping rules, read the policy with read-policy-tool.",
  model: "moonshotai/kimi-k2.6",
  tools: [AskDeskTool, ReadPolicyTool],
  maxToolCalls: 3,
})
export class HelplineAgent {}
