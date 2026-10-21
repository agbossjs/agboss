import { ScaffoldUsageError } from "./errors.js";
import { fullNameOf, namesOf, type Names } from "./names.js";
import type { AgentSpec, McpSpec, WorkflowSpec } from "./plan.js";

export interface CreateFlags {
  readonly agents?: string | undefined;
  readonly tools?: string | undefined;
  readonly mcp?: string | undefined;
  readonly rag?: string | undefined;
  readonly yes?: boolean | undefined;
}

const list = (text: string): string[] =>
  text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");

/**
 * `--agents "triage-agent:Sorts requests,answerer-agent:Answers"` +
 * `--tools "answerer-agent:search-orders-tool"` — full names only (#268 AC8), checked here.
 */
export function agentsFrom(agents: string, tools = ""): AgentSpec[] {
  const parsed = list(agents).map((item) => {
    const [name = "", ...rest] = item.split(":");
    const agent = fullNameOf(name, "agent");
    return {
      name: agent.full,
      description: rest.join(":").trim() || `${agent.title} (TODO: describe the role)`,
      tools: [] as string[],
    };
  });
  for (const item of list(tools)) {
    const [agent = "", tool = ""] = item.split(":").map((part) => part.trim());
    const target = parsed.find((a) => a.name === agent);
    if (target === undefined || tool === "")
      throw new ScaffoldUsageError(
        `--tools "${item}": expected <name>-agent:<name>-tool for an agent in --agents`,
      );
    target.tools.push(fullNameOf(tool, "tool").full);
  }
  return parsed;
}

/** The first workflow of a project: `<project>-workflow`. */
export const workflowNameOf = (project: string): string => `${namesOf(project).kebab}-workflow`;

/** The agent a workflow gets when none is named: `<workflow>-assistant-agent`. */
export const defaultAgentOf = (workflow: Names): AgentSpec => ({
  name: `${workflow.kebab}-assistant-agent`,
  description: `Helps with ${workflow.title}`,
  tools: [],
});

/** `--mcp none | filesystem:<dir> | command:<cmd>:<tool>` (the server is named after the project). */
export function mcpFrom(value: string, project: string): McpSpec {
  if (value === "none") return { kind: "none" };
  const [kind = "", first = "", second = ""] = value.split(":");
  if (kind === "filesystem" && first !== "")
    return { kind: "filesystem", name: `${project} files`, dir: first };
  if (kind === "command" && first !== "" && second !== "")
    return { kind: "command", name: `${project} server`, command: first, tool: second };
  throw new ScaffoldUsageError(
    `--mcp "${value}": use none, filesystem:<dir> or command:<cmd>:<tool>`,
  );
}

type Parsed = Partial<Pick<WorkflowSpec, "agents" | "mcp">> & {
  readonly rag?: WorkflowSpec["rag"] | null;
};

/** The knowledge base of a project: `<project>-notes-rag` over `folder`. */
export const ragOf = (project: string, folder: string): NonNullable<WorkflowSpec["rag"]> => ({
  name: `${namesOf(project).kebab}-notes-rag`,
  folder,
});

/** What the flags answer: `rag: null` = explicitly none. */
function parsed(name: string, flags: CreateFlags): Parsed {
  const rag =
    flags.rag === undefined ? {} : { rag: flags.rag === "none" ? null : ragOf(name, flags.rag) };
  return {
    ...(flags.agents === undefined ? {} : { agents: agentsFrom(flags.agents, flags.tools) }),
    ...(flags.mcp === undefined ? {} : { mcp: mcpFrom(flags.mcp, namesOf(name).kebab) }),
    ...rag,
  };
}

/**
 * Everything the questionnaire would ask, from flags, for the project `name`: its first workflow
 * `<name>-workflow`; `--yes` fills what is missing with defaults.
 */
export function specFromFlags(
  name: string,
  flags: CreateFlags,
): Partial<WorkflowSpec> & { name: string } {
  const { rag, ...answers } = parsed(name, flags);
  const withRag = rag === undefined || rag === null ? {} : { rag };
  const workflow = workflowNameOf(name);
  if (flags.yes !== true) return { name: workflow, ...answers, ...withRag };
  return {
    name: workflow,
    agents: answers.agents ?? [defaultAgentOf(namesOf(name))],
    mcp: answers.mcp ?? { kind: "none" },
    ...withRag,
  };
}

export const isComplete = (spec: Partial<WorkflowSpec>): spec is WorkflowSpec =>
  spec.agents !== undefined && spec.mcp !== undefined;
