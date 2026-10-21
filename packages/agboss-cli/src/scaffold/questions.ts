// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { input, select } from "@inquirer/prompts";
import { ragOf } from "./flags.js";
import { fullNameOf } from "./names.js";
import type { AgentSpec, McpSpec, WorkflowSpec } from "./plan.js";

async function askAgents(): Promise<AgentSpec[]> {
  const agents: AgentSpec[] = [];
  for (;;) {
    const name = (
      await input({
        message:
          agents.length === 0
            ? "First agent's full name (e.g. triage-agent):"
            : "Next agent's full name (empty to finish):",
      })
    ).trim();
    if (name === "") {
      if (agents.length > 0) return agents;
      continue;
    }
    const agent = fullNameOf(name, "agent");
    const description = await input({
      message: `What does ${agent.full} do?`,
      default: `${agent.title} (TODO: describe the role)`,
    });
    const tools = await input({
      message: `${agent.full}'s tools, full names (e.g. search-orders-tool; comma-separated, empty for none):`,
    });
    agents.push({
      name: agent.full,
      description,
      tools: tools
        .split(",")
        .map((t: string) => t.trim())
        .filter((t: string) => t !== "")
        .map((t: string) => fullNameOf(t, "tool").full),
    });
  }
}

/** The MCP server of the project (named after it: `<project> files`). */
async function askMcp(project: string): Promise<McpSpec> {
  const kind = await select({
    message: "An MCP server?",
    choices: [
      { name: "none", value: "none" },
      { name: "filesystem — read files in a folder", value: "filesystem" },
      { name: "my own command", value: "command" },
    ],
  });
  if (kind === "filesystem")
    return {
      kind,
      name: `${project} files`,
      dir: await input({ message: "Folder (absolute path):" }),
    };
  if (kind === "command") {
    const command = await input({ message: "Command that starts the server:" });
    return {
      kind,
      name: `${project} server`,
      command,
      tool: await input({ message: "One of its tools, by name:" }),
    };
  }
  return { kind: "none" };
}

/** The questionnaire (structure only) for whatever the flags did not answer. */
export async function askMissing(
  partial: Partial<WorkflowSpec> & { name: string },
): Promise<WorkflowSpec> {
  const project = partial.name.replace(/-workflow$/, "");
  const agents = partial.agents ?? (await askAgents());
  const mcp = partial.mcp ?? (await askMcp(project));
  const ragChoice =
    partial.agents === undefined
      ? await select({
          message: "A knowledge base?",
          choices: [
            { name: "none", value: "none" },
            { name: "notes in a folder (full-text search)", value: "notes" },
          ],
        })
      : "none";
  const rag =
    partial.rag ??
    (ragChoice === "notes"
      ? ragOf(project, await input({ message: "Folder:", default: "notes" }))
      : undefined);
  return { name: partial.name, agents, mcp, rag };
}
