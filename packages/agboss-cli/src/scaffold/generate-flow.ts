import { ScaffoldError } from "./errors.js";
import { finishRoute, routeLine, routerFile, type RouterFileSpec } from "./flow-files.js";
import type { GenerateOptions } from "./generate.js";
import { fullNameOf } from "./names.js";
import { agentFiles } from "./plan.js";
import { read } from "./project-files.js";
import { wireInto } from "./wire.js";
import { starCalls, wireAgentIntoFlow } from "./wire-flow.js";
import {
  finishOf,
  folderOf,
  importPath,
  ofKind,
  workflowGraph,
  type Component,
  type WorkflowGraph,
} from "./workflow-graph.js";
import type { Changes } from "./write.js";

const classNames = (graph: WorkflowGraph, decorator: string): string[] =>
  ofKind(graph, decorator).map((c) => c.className);

/** The router that chooses the agents: its `.toRouter(R).chooseOne(route(…)…)` in the flow (#272). */
function starRouterOf(graph: WorkflowGraph): Component {
  const routers = ofKind(graph, "Router").filter(
    (r) => starCalls(graph.flow, r.className) !== undefined,
  );
  const [router] = routers;
  if (router === undefined || routers.length > 1) {
    const found = routers.length === 0 ? "no" : routers.map((r) => r.className).join(", ");
    throw new ScaffoldError(
      `${graph.module.path}: expected one router choosing the agents (.toRouter(Router).chooseOne(route(…)…)), found ${found} — add the agent by hand`,
    );
  }
  return router;
}

/**
 * `agboss g agent <name>-agent --workflow <name>-workflow`: the agent and its prompt next to the workflow's agents; the
 * agent joins the router's choice — a route in `@Router({ routes })` (before a finish route) and
 * `route(Agent).toFinish(Finish)` in the flow's `chooseOne(…)`, the two lists the same (#272 AC6).
 * Resolved from the workflow module, whatever the layout.
 */
export function planAgent(root: string, name: string, o: GenerateOptions): Changes {
  const n = fullNameOf(name, "agent");
  const graph = workflowGraph(root, o);
  const router = starRouterOf(graph);
  const description = o.description ?? `${n.title} (TODO: describe the role)`;
  const folder = folderOf(graph, "Agent", "agents");
  const path = `${folder}/${n.kebab}/${n.kebab}.agent.ts`;
  const className = `${n.pascal}Agent`;
  return {
    create: agentFiles(folder, n, description, []),
    modify: [
      wireAgentIntoFlow(
        graph.module,
        { className, from: importPath(graph.module.path, path) },
        router.className,
        finishOf(graph).className,
      ),
      wireInto(read(root, router.path), {
        decorator: "Router",
        property: "routes",
        element: routeLine(className, description),
        name: className,
        from: importPath(router.path, path),
        before: classNames(graph, "WorkflowFinish"),
      }),
    ],
  };
}

/**
 * `agboss g router <name>-router --workflow <name>-workflow`: a router with the route to the workflow's finish, next to its
 * routers, ready for routes of its own. It is not put into the flow — where it sits is a choice.
 */
export function planRouter(root: string, name: string, o: GenerateOptions): Changes {
  const n = fullNameOf(name, "router");
  const graph = workflowGraph(root, o);
  const finish = finishOf(graph);
  const folder = folderOf(graph, "Router", "routers");
  const text: RouterFileSpec = {
    description: o.description ?? `${n.title} (TODO: say what it decides)`,
    prompt: "TODO: say how to choose between the routes.",
    maxVisits: 1,
  };
  const route = finishRoute(
    finish.className,
    importPath(`${folder}/${n.kebab}/${n.kebab}.router.ts`, finish.path),
  );
  return { create: [routerFile(folder, n, text, [route])], modify: [] };
}

/**
 * `agboss g workflow-start <name>-workflow-start [--workflow <name>-workflow]`: a `@WorkflowStart`
 * in the target workflow's folder (`src/workflows/<workflow>/<name>.workflow-start.ts`).
 */
export function planWorkflowStart(root: string, name: string, o: GenerateOptions): Changes {
  const n = fullNameOf(name, "workflow-start");
  const graph = workflowGraph(root, o);
  const description = o.description ?? `${n.title} (TODO: describe what starts the run)`;
  const content = [
    'import { WorkflowStartTextDto } from "agboss/dto";',
    'import { WorkflowStart } from "agboss";',
    "",
    `/** ${description} */`,
    "@WorkflowStart({",
    `  name: "${n.full}",`,
    `  description: ${JSON.stringify(description)},`,
    "  input: WorkflowStartTextDto,",
    "})",
    `export class ${n.pascal}WorkflowStart {}`,
    "",
  ].join("\n");
  return {
    create: [{ path: `${graph.dir}/${n.kebab}.workflow-start.ts`, content }],
    modify: [],
  };
}

/**
 * `agboss g workflow-finish <name>-workflow-finish [--workflow <name>-workflow]`: a `@WorkflowFinish`
 * in the target workflow's folder (`src/workflows/<workflow>/<name>.workflow-finish.ts`).
 */
export function planWorkflowFinish(root: string, name: string, o: GenerateOptions): Changes {
  const n = fullNameOf(name, "workflow-finish");
  const graph = workflowGraph(root, o);
  const description = o.description ?? `${n.title} (TODO: describe what finishes the run)`;
  const content = [
    'import { WorkflowFinishTextDto } from "agboss/dto";',
    'import { WorkflowFinish } from "agboss";',
    "",
    `/** ${description} */`,
    "@WorkflowFinish({",
    `  name: "${n.full}",`,
    `  description: ${JSON.stringify(description)},`,
    "  output: WorkflowFinishTextDto,",
    "})",
    `export class ${n.pascal}WorkflowFinish {}`,
    "",
  ].join("\n");
  return {
    create: [{ path: `${graph.dir}/${n.kebab}.workflow-finish.ts`, content }],
    modify: [],
  };
}
