import { dirname } from "node:path/posix";
import ts from "typescript";
import { ScaffoldError } from "./errors.js";
import type { GenerateOptions } from "./generate.js";
import { namesOf } from "./names.js";
import { render, vars } from "./plan.js";
import { importPath, workflowGraph, type Component, type WorkflowGraph } from "./workflow-graph.js";
import type { Changes, FileToWrite } from "./write.js";

/**
 * `agboss g arbiter <name> --workflow … [--agent …]` (#279 S77 i): a code arbiter for the agents of a
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

/** The launch the arbiter judges: the one with `--agent`, else the flow's only one. */
function launchFor(graph: WorkflowGraph, agent: string | undefined): readonly string[] {
  const launches = launchesOf(graph.source);
  const wanted = agent === undefined ? undefined : `${namesOf(agent).pascal}Agent`;
  const found =
    wanted === undefined
      ? launches.length === 1
        ? launches[0]
        : undefined
      : launches.find((launch) => launch.includes(wanted) || launch.includes(agent ?? ""));
  if (found !== undefined) return found;
  const why =
    launches.length === 0
      ? "has no .toParallelAgents(…) launch to judge"
      : wanted === undefined
        ? `has ${String(launches.length)} agents' launches — name one of its agents with --agent <name>`
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

/** The arbiters' folder: `arbiters/` beside the workflow's agents, else beside the workflow. */
function folderOf(graph: WorkflowGraph, agents: readonly Component[]): string {
  const [first] = agents;
  return first === undefined ? `${graph.dir}/arbiters` : `${dirname(dirname(first.path))}/arbiters`;
}

/** `agboss g arbiter <name>`: the arbiter's file; nothing is rewired. */
export function planArbiter(root: string, name: string, o: GenerateOptions): Changes {
  const graph = workflowGraph(root, o.workflow, "arbiter");
  const agents = launchFor(graph, o.agent).map((agent) => componentOf(graph, agent));
  const n = namesOf(name);
  const path = `${folderOf(graph, agents)}/${n.kebab}.arbiter.ts`;
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
