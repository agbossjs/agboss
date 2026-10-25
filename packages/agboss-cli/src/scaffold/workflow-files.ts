import { basename, dirname } from "node:path/posix";
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
  /** Its folder: `src/workflows/desk`. */
  readonly dir: string;
  /** The shared `src/` root where agents, routers, tools, dto, mcp, rag live. */
  readonly srcDir?: string;
  /** The router's short name: `"main"` for the first workflow, `"<workflow> main"` for subsequent ones. */
  readonly routerName?: string;
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
  srcDir: string,
  firstAgent: FileToWrite,
): { files: FileToWrite[]; agent: FileToWrite; server: string } {
  const files: FileToWrite[] = [];
  let agent = firstAgent;
  let server = "";
  if (spec.mcp.kind !== "none") {
    const mcp = mcpFiles(srcDir, spec.mcp);
    files.push(...mcp.files);
    server = mcp.server;
    agent = wire(agent, "Agent", "tools", mcp.tool, mcp.tool, `../../${mcp.toolModule}.js`);
  }
  if (spec.rag !== undefined) {
    const name = fullNameOf(spec.rag.name, "rag");
    const rag = ragFiles(srcDir, { name, folder: spec.rag.folder });
    files.push(...rag.files);
    const element = `{ use: ${rag.knowledge}, mode: RagMode.Tool }`;
    const from = `../../rag/${name.kebab}.rag.js`;
    agent = wire(agent, "Agent", "rag", element, rag.knowledge, from);
    // the mode is an enum (#269): its import goes with the knowledge base's
    agent = { ...agent, content: addImport(agent.content, agent.path, "RagMode", "agboss") };
  }
  return { files, agent, server };
}

/** The workflow module's imports: its agents, its MCP server, the project's `ApiService`. */
function moduleImports(
  modulePath: string,
  srcDir: string,
  spec: WorkflowSpec,
  agents: readonly PlannedAgent[],
  server: string,
  service: string | undefined,
): string {
  return [
    ...agents.map((a) => {
      const target = `${srcDir}/agents/${a.names.kebab}/${a.names.kebab}.agent.ts`;
      return `import { ${a.names.pascal}Agent } from "${importPath(modulePath, target)}";`;
    }),
    ...(spec.mcp.kind === "none"
      ? []
      : [
          `import { ${server} } from "${importPath(modulePath, `${srcDir}/mcp/${namesOf(spec.mcp.name).kebab}.mcp-server.ts`)}";`,
        ]),
    ...(service === undefined ? [] : [`import { ApiService } from "${service}";`]),
  ].join("\n");
}

/** The workflow's test on `agboss/testing`: its first agent, by script, in its application. */
function workflowTest(
  dir: string,
  srcDir: string,
  workflow: Names,
  first: PlannedAgent,
  routerNames: Names,
  at: WorkflowPlacement,
): FileToWrite {
  const path = `tests/workflows/${workflow.kebab}/${workflow.kebab}.workflow.test.ts`;
  return {
    path,
    content: render("workflow/workflow.test.ts.tmpl", {
      agent: first.names.pascal,
      agentName: first.names.full,
      agentFrom: importPath(
        path,
        `${srcDir}/agents/${first.names.kebab}/${first.names.kebab}.agent.ts`,
      ),
      routerClass: `${routerNames.pascal}Router`,
      routerFrom: importPath(
        path,
        `${srcDir}/routers/${routerNames.kebab}/${routerNames.kebab}.router.ts`,
      ),
      finishFrom: importPath(path, `${dir}/text.workflow-finish.ts`),
      startFrom: importPath(path, `${dir}/text.workflow-start.ts`),
      application: at.application.className,
      applicationFrom: importPath(path, at.application.path),
    }),
  };
}

/** What the tools of the workflow reach: the project's `ApiService` (`agboss create`), else nothing. */
const toolApiOf = (srcDir: string, tool: Names, at: WorkflowPlacement): ToolApi | undefined => {
  if (at.service === undefined) return undefined;
  const test = `${srcDir}/tools/${tool.kebab}.tool.test.ts`;
  return {
    service: importPath(`${srcDir}/tools/${tool.kebab}.tool.ts`, at.service),
    application: at.application.className,
    applicationFrom: importPath(test, at.application.path),
  };
};

const srcDirFrom = (at: WorkflowPlacement): string =>
  at.srcDir ?? (basename(dirname(at.dir)) === "workflows" ? dirname(dirname(at.dir)) : at.dir);

/**
 * Every file of one new workflow (#268 AC8): its start and finish, its main router, its agents with
 * their tools and tests, its MCP server and knowledge base, the module and its test. Names are
 * full names: the workflow's ends with `-workflow`, an agent's with `-agent`, a tool's with `-tool`.
 */
export function planWorkflow(spec: WorkflowSpec, at: WorkflowPlacement): FileToWrite[] {
  const workflow = fullNameOf(spec.name, "workflow");
  const { dir } = at;
  const srcDir = srcDirFrom(at);
  const routerNames = namesOf(at.routerName ?? "main");
  const agents: PlannedAgent[] = spec.agents.map((a) => ({
    spec: a,
    names: fullNameOf(a.name, "agent"),
    tools: a.tools.map((tool) => fullNameOf(tool, "tool")),
  }));
  const [first] = agents;
  if (first === undefined) throw new ScaffoldUsageError("A workflow needs at least one agent");
  const [firstAgent, ...otherAgentFiles] = agents.flatMap((a) =>
    agentFiles(`${srcDir}/agents`, a.names, a.spec.description, a.tools),
  );
  if (firstAgent === undefined) throw new ScaffoldUsageError("A workflow needs at least one agent");
  const more = extras(spec, srcDir, firstAgent);
  const modulePath = `${dir}/${workflow.kebab}.workflow.ts`;
  const service = at.service === undefined ? undefined : importPath(modulePath, at.service);
  const router = routerFile(
    `${srcDir}/routers`,
    routerNames,
    MAIN_ROUTER,
    agents.map((a) => agentRoute(a.names, a.spec.description)),
    `${workflow.kebab}-main`,
  );
  const module = render("workflow/workflow.ts.tmpl", {
    ...vars(workflow),
    routerClass: `${routerNames.pascal}Router`,
    routerFrom: importPath(modulePath, router.path),
    imports: moduleImports(modulePath, srcDir, spec, agents, more.server, service),
    routes: agents
      .map((a) => `        route(${a.names.pascal}Agent)\n          .toFinish(TextWorkflowFinish),`)
      .join("\n"),
    servers: more.server,
    providers: service === undefined ? "" : "  providers: [ApiService],\n",
  });
  return [
    ...endpointFiles(dir, workflow),
    router,
    ...agents.flatMap((a) =>
      a.tools.flatMap((t) => toolFiles(`${srcDir}/tools`, t, toolApiOf(srcDir, t, at))),
    ),
    ...more.files,
    more.agent,
    ...otherAgentFiles,
    { path: modulePath, content: module },
    workflowTest(dir, srcDir, workflow, first, routerNames, at),
  ];
}
