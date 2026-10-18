import { appWorkflowOf, rememberAppWorkflow } from "../app/app-workflow.js";
import type { BuiltApp } from "../app/create-app.js";
import type { App } from "../app/types.js";
import type { Class } from "../components/injection.js";
import { NodeKind } from "../flow/ast.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import type { AssembledApplication } from "./assemble.js";
import type { GracefulStop } from "./graceful-stop.js";

/**
 * The app of an application instance (#261): `execute` runs the workflow its start belongs to (a
 * start is the door of one workflow), `resume` / `cancel` the workflow of the thread; `close()` is
 * the instance's graceful stop (`graceful-stop.ts`).
 */

/** Each start class with the workflow it opens. */
function startsOf(workflows: readonly BuiltApp[]): ReadonlyMap<Class, BuiltApp> {
  const starts = new Map<Class, BuiltApp>();
  for (const workflow of workflows) {
    for (const node of workflow.bundle.graph.nodes.values()) {
      if (node.kind === NodeKind.Start) starts.set(node.component, workflow);
    }
  }
  return starts;
}

/** Each app's workflows by class, with the start a plain text goes to in each (internal). */
const textStarts = new WeakMap<App, ReadonlyMap<Class, Class | undefined>>();

/**
 * The start a plain text goes to in one workflow of the app (the CLI's `--workflow` until #268
 * chooses by `--start`); `undefined` when the workflow has none or is not in the app.
 */
export const textStartOfWorkflow = (app: App, workflow: Class): Class | undefined =>
  textStarts.get(app)?.get(workflow);

/** The start a plain text goes to: the first listed workflow's that has one. */
const textStartOf = (workflows: readonly BuiltApp[]): Class | undefined =>
  workflows.map((workflow) => workflow.app.textStart).find((start) => start !== undefined);

export function composeApp(
  assembled: AssembledApplication,
  workflows: readonly BuiltApp[],
  stop: GracefulStop,
): App {
  const [first] = workflows;
  // the assembly rejects an application without workflows
  if (first === undefined) throw new Error(`${assembled.name} has no workflows`);
  const starts = startsOf(workflows);
  /** The workflow a tenant's thread belongs to; an unknown thread goes to the first, which rejects it. */
  const ofThread = async (thread: string, tenantId = DEFAULT_TENANT_ID): Promise<BuiltApp> => {
    for (const workflow of workflows) {
      const { terns, config } = workflow.deps;
      if (await terns.hasThread(config.name, tenantId, thread)) return workflow;
    }
    return first;
  };
  const app: App = {
    name: assembled.name,
    version: assembled.version,
    warnings: workflows.flatMap((workflow) => workflow.app.warnings),
    models: [...new Set(workflows.flatMap((workflow) => workflow.app.models))],
    textStart: textStartOf(workflows),
    // a start no workflow has goes to the first, whose check rejects it (`onRunRejected`)
    execute: (start, input, ...options) =>
      (starts.get(start) ?? first).app.execute(start, input, ...options),
    resume: async (threadId, decision, options) =>
      (await ofThread(threadId, options?.tenantId)).app.resume(threadId, decision, options),
    cancel: async (threadId, options) =>
      (await ofThread(threadId, options?.tenantId)).app.cancel(threadId, options),
    close: (options) => stop.close(options),
    resolve: (token) => first.app.resolve(token),
    hasTool: (name) => workflows.some((workflow) => workflow.app.hasTool(name)),
  };
  textStarts.set(
    app,
    new Map(workflows.map((workflow) => [workflow.bundle.graph.type, workflow.app.textStart])),
  );
  const remembered = appWorkflowOf(first.app);
  if (remembered !== undefined) rememberAppWorkflow(app, remembered);
  return app;
}
