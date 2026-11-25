import { join } from "node:path";
import { Tool } from "@agboss/core";
import { kilobytes, seconds } from "@agboss/core/units";
import { PolicyFileContent, PolicyTopic } from "../dto/policy-files.dto.js";
import { POLICIES_DIR, PolicyFilesServer } from "./policy-files.server.js";

/** The tool the helpline's model sees: one policy by topic, read through the MCP server. */
@Tool({
  name: "read-policy-tool",
  description: "Reads the customer policy on returns or shipping",
  input: PolicyTopic,
  output: PolicyFileContent,
  timeout: seconds(10),
  maxResultSize: kilobytes(16),
  deps: [PolicyFilesServer],
})
export class ReadPolicyTool {
  constructor(private readonly policyFilesServer: PolicyFilesServer) {}

  execute({ topic }: PolicyTopic): Promise<PolicyFileContent> {
    const path = join(POLICIES_DIR, `${topic}.md`);
    // the running step's signal is picked up by the call itself
    return this.policyFilesServer.call("read_text_file", { path });
  }
}
