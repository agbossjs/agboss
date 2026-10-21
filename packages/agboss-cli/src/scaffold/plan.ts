import { renderTemplate } from "agboss/internal";
import { readFileSync } from "node:fs";
import { ScaffoldError } from "./errors.js";
import type { Names } from "./names.js";
import type { FileToWrite } from "./write.js";

const TEMPLATES = new URL("../../templates/", import.meta.url);

/** A template of the package rendered with `variables`; an unknown variable is a bug in the template. */
export const render = (path: string, variables: Readonly<Record<string, string>>): string =>
  renderTemplate(
    readFileSync(new URL(path, TEMPLATES), "utf8"),
    variables,
    (key) => new ScaffoldError(`template ${path}: unknown variable {{${key}}}`),
  );

export const vars = (n: Names): Record<string, string> => ({
  kebab: n.kebab,
  snake: n.snake,
  pascal: n.pascal,
  title: n.title,
});

/** An agent of a new workflow: its full name (`triage-agent`), its role, its tools' full names. */
export interface AgentSpec {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly string[];
}
export type McpSpec =
  | { readonly kind: "none" }
  | { readonly kind: "filesystem"; readonly name: string; readonly dir: string }
  | {
      readonly kind: "command";
      readonly name: string;
      readonly command: string;
      readonly tool: string;
    };
/** A new workflow: its full name (`desk-workflow`), its agents, its MCP server, its knowledge base. */
export interface WorkflowSpec {
  readonly name: string;
  readonly agents: readonly AgentSpec[];
  readonly mcp: McpSpec;
  /** The knowledge base: its full name (`desk-notes-rag`) and the folder it indexes. */
  readonly rag?: { readonly name: string; readonly folder: string } | undefined;
}

/** What a tool of `agboss create` reaches (#239): the project's `ApiService` and its application. */
export interface ToolApi {
  /** The service's module, as the tool imports it: `../../services/api.service.js`. */
  readonly service: string;
  /** The application the tool's test runs it in, and its module as the test imports it. */
  readonly application: string;
  readonly applicationFrom: string;
}

/**
 * What a tool that reaches the project's API adds (#239): it injects the project's `ApiService`
 * after the execution context (#280), each field named after its type.
 */
const apiVariables = (tool: Names, api: ToolApi): Record<string, string> => ({
  serviceImport: `import { ApiService } from "${api.service}";`,
  deps: "  deps: [ExecutionContext, ApiService],\n",
  constructor:
    "  constructor(\n    private readonly executionContext: ExecutionContext,\n    private readonly apiService: ApiService,\n  ) {}\n\n",
  serviceUse: `, API: \${this.apiService.url("/${tool.kebab}")}`,
});

/** A tool on its own: only the execution context through its constructor (#280). */
const NO_API = {
  serviceImport: "",
  deps: "  deps: [ExecutionContext],\n",
  constructor: "  constructor(private readonly executionContext: ExecutionContext) {}\n\n",
  serviceUse: "",
};

/**
 * A tool (`<name>-tool`, class `<Name>Tool`) and its test in `folder`. With `api` (`agboss create`,
 * #239) the tool injects the project's `ApiService` and its test runs it in the application, on its
 * environment.
 */
export function toolFiles(folder: string, tool: Names, api?: ToolApi): FileToWrite[] {
  const variables = { ...vars(tool), ...(api === undefined ? NO_API : apiVariables(tool, api)) };
  const test =
    api === undefined
      ? render("tool/tool.test.ts.tmpl", variables)
      : render("tool/tool-api.test.ts.tmpl", {
          ...variables,
          application: api.application,
          applicationFrom: api.applicationFrom,
        });
  return [
    { path: `${folder}/${tool.kebab}.tool.ts`, content: render("tool/tool.ts.tmpl", variables) },
    { path: `${folder}/${tool.kebab}.tool.test.ts`, content: test },
  ];
}

/** An agent (`<name>-agent`) and its prompt in `folder` (`<workflow>/agents`), its tools in `../tools`. */
export function agentFiles(
  folder: string,
  agent: Names,
  description: string,
  tools: readonly Names[],
): FileToWrite[] {
  const imports = tools
    .map((t) => `import { ${t.pascal}Tool } from "../tools/${t.kebab}.tool.js";`)
    .join("\n");
  const variables = {
    ...vars(agent),
    description: description.replace(/"/g, "'"),
    imports,
    tools: tools.map((t) => `${t.pascal}Tool`).join(", "),
  };
  return [
    {
      path: `${folder}/${agent.kebab}.agent.ts`,
      content: render("agent/agent.ts.tmpl", variables).replace(/\n\n\n/g, "\n\n"),
    },
    {
      path: `${folder}/${agent.kebab}.prompt.md`,
      content: render("agent/agent.prompt.md.tmpl", variables),
    },
  ];
}
