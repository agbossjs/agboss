import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, McpServerClient } from "@agboss/core/mcp";
import { PolicyFileContent, PolicyFileRead } from "./policy-files.dto.js";

/** The customer policies the helpline reads: `data/policies/` of this example. */
export const POLICIES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "data",
  "policies",
);

/** The official filesystem MCP server (a dependency of this example), run with the current Node. */
const FILESYSTEM_SERVER = join(
  dirname(
    createRequire(import.meta.url).resolve("@modelcontextprotocol/server-filesystem/package.json"),
  ),
  "dist",
  "index.js",
);

/** The server tools the helpline uses — checked against the server when the application starts. */
const tools = {
  read_text_file: { input: PolicyFileRead, output: PolicyFileContent },
};

/**
 * The filesystem MCP server, limited to the policies folder: local, no network. Tests never start
 * it — `mcpOf(PolicyFilesServer)` answers its tools.
 */
@McpServer({
  name: "policy-files",
  transport: "stdio",
  command: process.execPath,
  args: [FILESYSTEM_SERVER, POLICIES_DIR],
  tools,
})
export class PolicyFilesServer extends McpServerClient<typeof tools> {}
