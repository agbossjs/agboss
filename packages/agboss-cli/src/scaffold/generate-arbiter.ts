import { basename, dirname } from "node:path/posix";
import ts from "typescript";
import { ScaffoldError } from "./errors.js";
import type { GenerateOptions } from "./generate.js";
import { fullNameOf } from "./names.js";
import { render, vars } from "./plan.js";
import {
  agentOf,
  importPath,
  srcDirOf,
  workflowGraph,
  type Component,
  type WorkflowGraph,
} from "./workflow-graph.js";
import type { Changes, FileToWrite } from "./write.js";

/**
 * `agboss g arbiter <name>-arbiter --workflow <name>-workflow [--agent <name>-agent]` (#279 S77 i): a code arbiter for the agents of a
 * launch — the flow's one `.toParallelAgents(…)`, or the one launching `--agent` — with one
 * `@OnAnswer(Agent) from<Agent>(answer)` method per distinct agent class, each accepting every
 * answer until it is written. It is not put into the flow: where it sits (`.acceptedBy(…)`) is a
 * choice.
 */

const isCallOf = (node: ts.CallExpression, name: string): boolean =>
  ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === name;

/** The agent classes of every `.toParallelAgents(…)` of the flow, repeats removed, as listed. */
function launchesOf(source: ts.SourceFile): readonly (readonly string[])[] {
  const launches: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCallOf(node, "toParallelAgents")) {
      const agents = node.arguments.flatMap((arg) => (ts.isIdentifier(arg) ? [arg.text] : []));
      launches.push([...new Set(agents)]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return launches;
}

/** The launch the arbiter judges: the one with `--agent <full name>`, else the flow's only one. */
function launchFor(graph: WorkflowGraph, agent: string | undefined): readonly string[] {
  const launches = launchesOf(graph.source);
  const wanted = agent === undefined ? undefined : agentOf(graph, agent).className;
  const found =
    wanted === undefined
      ? launches.length === 1
        ? launches[0]
        : undefined
      : launches.find((launch) => launch.includes(wanted));
  if (found !== undefined) return found;
  const why =
    launches.length === 0
      ? "has no .toParallelAgents(…) launch to judge"
      : wanted === undefined
        ? `has ${String(launches.length)} agents' launches — name one of its agents with --agent <full name>`
        : `launches no ${wanted}`;
  throw new ScaffoldError(`${graph.module.path} ${why}`);
}

/** `fromScoreA` for `ScoreAAgent`, the name `agboss check` expects (`[arbiter.method-name]`). */
const methodOf = (agent: string): string =>
  [
    `  @OnAnswer(${agent})`,
    `  from${agent.replace(/Agent$/, "")}(answer: ArbiterAnswerOf<typeof ${agent}>): boolean {`,
    "    return Object.keys(answer).length > 0; // TODO: whether this answer counts",
    "  }",
  ].join("\n");

const componentOf = (graph: WorkflowGraph, agent: string): Component => {
  const found = graph.components.find((component) => component.className === agent);
  if (found === undefined)
    throw new ScaffoldError(`${graph.module.path}: ${agent} is not imported from a project file`);
  return found;
};

/** The arbiters' folder: `arbiters/` beside the workflow's agents, else `<srcDir>/arbiters`. */
function folderOf(graph: WorkflowGraph, agents: readonly Component[]): string {
  const [first] = agents;
  if (first === undefined) return `${srcDirOf(graph)}/arbiters`;
  const dir = dirname(first.path);
  const agentsFolder = basename(dir) === "agents" ? dir : dirname(dir);
  return `${dirname(agentsFolder)}/arbiters`;
}

/** `agboss g arbiter <name>`: the arbiter's file; nothing is rewired. */
export function planArbiter(root: string, name: string, o: GenerateOptions): Changes {
  const n = fullNameOf(name, "arbiter");
  const graph = workflowGraph(root, o);
  const agents = launchFor(graph, o.agent).map((agent) => componentOf(graph, agent));
  const path = `${folderOf(graph, agents)}/${n.kebab}/${n.kebab}.arbiter.ts`;
  const imports = agents
    .map((agent) => `import { ${agent.className} } from "${importPath(path, agent.path)}";`)
    .join("\n");
  const methods = agents.map((agent) => methodOf(agent.className)).join("\n\n");
  const file: FileToWrite = {
    path,
    content: render("arbiter/arbiter.ts.tmpl", { ...vars(n), imports, methods }),
  };
  return { create: [file], modify: [] };
}
