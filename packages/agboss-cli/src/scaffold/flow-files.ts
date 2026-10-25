import type { Names } from "./names.js";
import { render, vars } from "./plan.js";
import type { FileToWrite } from "./write.js";

/** One route of a generated router: its target class, the module it comes from, what it means. */
export interface RouteSpec {
  readonly target: string;
  readonly from: string;
  readonly text: string;
}

/** What the finish route of every generated router says — a stop instruction (CLAUDE.md, `@Router`). */
export const FINISH_ROUTE_TEXT =
  "Stop and send the answer: the contributions so far answer the message, or the last agent asked a question and waits for the reply, or it cannot be done";

/** The finish route every generated router has: the workflow finish class and its module. */
export const finishRoute = (target: string, from: string): RouteSpec => ({
  target,
  from,
  text: FINISH_ROUTE_TEXT,
});

const quoted = (text: string): string => text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** `route(BillingAgent, "Handles invoices")` — how `agboss` writes a route. */
export const routeLine = (target: string, text: string): string =>
  `{ prompt: "${quoted(text)}", target: ${target} }`;

/** An agent's route in the main router: the agent class and its description. */
export const agentRoute = (agent: Names, description: string): RouteSpec => ({
  target: `${agent.pascal}Agent`,
  from: `../../agents/${agent.kebab}/${agent.kebab}.agent.js`,
  text: description,
});

/**
 * The text workflow start and the text workflow finish of a new workflow, their `name`s prefixed
 * with the workflow's (`desk-text-workflow-start`): a name is unique in the application (#272).
 */
export function endpointFiles(dir: string, workflow: Names): FileToWrite[] {
  const prefix = { workflowKebab: workflow.kebab };
  return [
    {
      path: `${dir}/workflow-starts/text.workflow-start.ts`,
      content: render("workflow-start/text.workflow-start.ts.tmpl", prefix),
    },
    {
      path: `${dir}/workflow-finishes/text.workflow-finish.ts`,
      content: render("workflow-finish/text.workflow-finish.ts.tmpl", prefix),
    },
  ];
}

/** What a generated router says, and how many times one run may pass through it. */
export interface RouterFileSpec {
  readonly description: string;
  readonly prompt: string;
  /** Required: a router on a cycle without it breaks `graph.cycle-without-max-visits`. */
  readonly maxVisits: number;
}

/**
 * A router file (`<folder>/<name>/<name>.router.ts`) with its routes and their imports; its `name` is
 * `<id>-router` (`id` defaults to the router's own kebab name).
 */
export function routerFile(
  folder: string,
  router: Names,
  spec: RouterFileSpec,
  routes: readonly RouteSpec[],
  id: string = router.kebab,
): FileToWrite {
  const imports = routes.map((r) => `import { ${r.target} } from "${r.from}";`).join("\n");
  return {
    path: `${folder}/${router.kebab}/${router.kebab}.router.ts`,
    content: render("router/router.ts.tmpl", {
      ...vars(router),
      id,
      description: quoted(spec.description),
      prompt: quoted(spec.prompt),
      maxVisits: String(spec.maxVisits),
      imports,
      routes: routes.map((r) => `    ${routeLine(r.target, r.text)},`).join("\n"),
    }),
  };
}

/** What the main router of a generated workflow says; the star around it is a cycle. */
export const MAIN_ROUTER: RouterFileSpec = {
  description: "Sends the message to the agent that answers it",
  prompt: "Pick the agent that answers the message.",
  maxVisits: 3,
};
