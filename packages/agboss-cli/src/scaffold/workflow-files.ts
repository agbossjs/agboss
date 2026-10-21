import { ScaffoldUsageError } from "./errors.js";
import { agentRoute, endpointFiles, MAIN_ROUTER, routerFile } from "./flow-files.js";
import { fullNameOf, namesOf, type FullName, type Names } from "./names.js";
import { mcpFiles, ragFiles } from "./parts.js";
import { agentFiles, render, toolFiles, vars, type ToolApi, type WorkflowSpec } from "./plan.js";
import { addImport, wire } from "./wire.js";
import { importPath } from "./workflow-graph.js";
import type { FileToWrite } from "./write.js";

/** Where a new workflow goes and what it belongs to. */
export interface WorkflowPlacement {
  /** Its folder: `src/desk`. */
  readonly dir: string;
  /** The application it is listed in: its class and its module. */
  readonly application: { readonly className: string; readonly path: string };
  /** `agboss create` (#239): the project's `ApiService` module, which its tools inject. */
  readonly service?: string;
}

interface PlannedAgent {
  readonly spec: WorkflowSpec["agents"][number];
  readonly names: FullName;
  readonly tools: readonly FullName[];
}

/** MCP server and knowledge base of a new workflow — both wired into its first agent. */
function extras(
  spec: WorkflowSpec,
  dir: string,
  firstAgent: FileToWrite,
): { files: FileToWrite[]; agent: FileToWrite; server: string } {
  const files: FileToWrite[] = [];
  let agent = firstAgent;
  let server = "";
  if (spec.mcp.kind !== "none") {
    const mcp = mcpFiles(dir, spec.mcp);
    files.push(...mcp.files);
    server = mcp.server;
    agent = wire(agent, "Agent", "tools", mcp.tool, mcp.tool, `../${mcp.toolModule}.js`);
  }
  if (spec.rag !== undefined) {
    const name = fullNameOf(spec.rag.name, "rag");
    const rag = ragFiles(dir, { name, folder: spec.rag.folder });
    files.push(...rag.files);
    const element = `{ use: ${rag.knowledge}, mode: RagMode.Tool }`;
    const from = `../rag/${name.kebab}.rag.js`;
    agent = wire(agent, "Agent", "rag", element, rag.knowledge, from);
    // the mode is an enum (#269): its import goes with the knowledge base's
    agent = { ...agent, content: addImport(agent.content, agent.path, "RagMode", "agboss") };
  }
  return { files, agent, server };
}

/** The workflow module's imports: its agents, its MCP server, the project's `ApiService`. */
function moduleImports(
  spec: WorkflowSpec,
  agents: readonly PlannedAgent[],
  server: string,
  service: string | undefined,
): string {
  return [
    ...agents.map(
      (a) => `import { ${a.names.pascal}Agent } from "./agents/${a.names.kebab}.agent.js";`,
    ),
    ...(spec.mcp.kind === "none"
      ? []
      : [`import { ${server} } from "./mcp/${namesOf(spec.mcp.name).kebab}.server.js";`]),
    ...(service === undefined ? [] : [`import { ApiService } from "${service}";`]),
  ].join("\n");
}

/** The workflow's test on `agboss/testing`: its first agent, by script, in its application. */
function workflowTest(
  dir: string,
  workflow: Names,
  first: PlannedAgent,
  at: WorkflowPlacement,
): FileToWrite {
  const path = `${dir}/${workflow.kebab}.workflow.test.ts`;
  return {
    path,
    content: render("workflow/workflow.test.ts.tmpl", {
      agent: first.names.pascal,
      agentKebab: first.names.kebab,
      agentName: first.names.full,
      application: at.application.className,
      applicationFrom: importPath(path, at.application.path),
    }),
  };
}

/** What the tools of the workflow reach: the project's `ApiService` (`agboss create`), else nothing. */
const toolApiOf = (dir: string, tool: Names, at: WorkflowPlacement): ToolApi | undefined => {
  if (at.service === undefined) return undefined;
  const test = `${dir}/tools/${tool.kebab}.tool.test.ts`;
  return {
    service: importPath(`${dir}/tools/${tool.kebab}.tool.ts`, at.service),
    application: at.application.className,
    applicationFrom: importPath(test, at.application.path),
  };
};

/**
 * Every file of one new workflow (#268 AC8): its start and finish, its main router, its agents with
 * their tools and tests, its MCP server and knowledge base, the module and its test. Names are
 * full names: the workflow's ends with `-workflow`, an agent's with `-agent`, a tool's with `-tool`.
 */
export function planWorkflow(spec: WorkflowSpec, at: WorkflowPlacement): FileToWrite[] {
  const workflow = fullNameOf(spec.name, "workflow");
  const { dir } = at;
  const agents: PlannedAgent[] = spec.agents.map((a) => ({
    spec: a,
    names: fullNameOf(a.name, "agent"),
    tools: a.tools.map((tool) => fullNameOf(tool, "tool")),
  }));
  const [first] = agents;
  if (first === undefined) throw new ScaffoldUsageError("A workflow needs at least one agent");
  const [firstAgent, ...otherAgentFiles] = agents.flatMap((a) =>
    agentFiles(`${dir}/agents`, a.names, a.spec.description, a.tools),
  );
  if (firstAgent === undefined) throw new ScaffoldUsageError("A workflow needs at least one agent");
  const more = extras(spec, dir, firstAgent);
  const service = at.service === undefined ? undefined : importPath(`${dir}/x.ts`, at.service);
  const module = render("workflow/workflow.ts.tmpl", {
    ...vars(workflow),
    imports: moduleImports(spec, agents, more.server, service),
    // one call per line (#289): `route(X)` / `.toFinish(…)`
    routes: agents
      .map((a) => `        route(${a.names.pascal}Agent)\n          .toFinish(TextWorkflowFinish),`)
      .join("\n"),
    servers: more.server,
    // the service the tools inject (`deps: [ExecutionContext, ApiService]`) — the container creates registered ones
    providers: service === undefined ? "" : "  providers: [ApiService],\n",
  });
  // a text agent answers straight to the finish: the router chooses among the agents (#272)
  const router = routerFile(
    `${dir}/routers`,
    namesOf("main"),
    MAIN_ROUTER,
    agents.map((a) => agentRoute(a.names, a.spec.description)),
    `${workflow.kebab}-main`,
  );
  return [
    ...endpointFiles(dir, workflow),
    router,
    ...agents.flatMap((a) =>
      a.tools.flatMap((t) => toolFiles(`${dir}/tools`, t, toolApiOf(dir, t, at))),
    ),
    ...more.files,
    more.agent,
    ...otherAgentFiles,
    { path: `${dir}/${workflow.kebab}.workflow.ts`, content: module },
    workflowTest(dir, workflow, first, at),
  ];
}
