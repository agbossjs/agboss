import { join } from "node:path";
import { ExecutionContext, type ToolHandler } from "@agboss/core";
import { McpTool } from "@agboss/core/mcp";
import { kilobytes, seconds } from "@agboss/core/units";
import { PolicyFileContent, PolicyTopic } from "./policy-files.dto.js";
import { POLICIES_DIR, PolicyFilesServer } from "./policy-files.server.js";

/** The tool the helpline's model sees: one policy by topic, read through the MCP server. */
@McpTool({
  server: PolicyFilesServer,
  name: "read-policy-tool",
  description: "Reads the customer policy on returns or shipping",
  input: PolicyTopic,
  output: PolicyFileContent,
  timeout: seconds(10),
  maxResultSize: kilobytes(16),
  deps: [PolicyFilesServer, ExecutionContext],
})
export class ReadPolicyTool implements ToolHandler<PolicyTopic, PolicyFileContent> {
  constructor(
    private readonly policyFilesServer: PolicyFilesServer,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ topic }: PolicyTopic): Promise<PolicyFileContent> {
    const path = join(POLICIES_DIR, `${topic}.md`);
    return this.policyFilesServer.call("read_text_file", { path }, this.executionContext.signal);
  }
}
