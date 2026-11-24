import { executionControlOf, type ExecutionControl } from "../app/execution-control.js";
import type { BuiltApp } from "../app/create-app.js";
import type { AnyTenantApp, ExecutionOutput } from "../app/types.js";
import type { BuiltApplication } from "../application/create-app.js";
import type { Class, Resolved, Token } from "../components/injection.js";
import { definedOf } from "../infrastructure/clock.js";
import type { TestEnvironment } from "./environment.js";
import { TestSetupError } from "./errors.js";
import { toolNameOf } from "./script.js";
import { actionSlice, agentSlice, routerSlice, toolSlice } from "./slices.js";
import type { TestApp } from "./test-app.js";

/** `resolve` and `get`: what the built app's container holds for a token (a class, a value, an env dictionary). */
export const resolvingOf = (readyApp: () => AnyTenantApp): Pick<TestApp, "resolve" | "get"> => ({
  resolve: (token) => readyApp().resolve(token),
  get: <TToken extends Token>(token: TToken): Resolved<TToken> =>
    readyApp().resolve(token as Class) as Resolved<TToken>,
});

/** The built app's execution control (#807), reached once the app is built. */
export function forwardedControlOf(readyApp: () => AnyTenantApp): ExecutionControl {
  const control = (): ExecutionControl =>
    definedOf(executionControlOf(readyApp()), "a built application has its execution control");
  return {
    cancelExecution: (request) => control().cancelExecution(request),
    executionStateOf: (tree) => control().executionStateOf(tree),
    claimExecutionId: (identity) => control().claimExecutionId(identity),
  };
}

/** Rethrows what the test must see: a reported failure wins over the run's own error. */
export async function checked<T>(environment: TestEnvironment, work: () => Promise<T>): Promise<T> {
  let value: T;
  try {
    value = await work();
  } catch (error) {
    throw environment.book.takeFailure() ?? error;
  }
  const failure = environment.book.takeFailure();
  if (failure !== undefined) throw failure;
  return value;
}

/** The output a call gave, kept as the last one the test saw: the pause `answerPause` answers. */
export function remembered<TOutput extends ExecutionOutput>(
  environment: TestEnvironment,
  output: TOutput,
): TOutput {
  environment.lastOutput = output;
  return output;
}

/** The workflow of the application a component is in (its first, for a shared one); else the first. */
export function workflowWith(built: BuiltApplication, component: Class): BuiltApp {
  const found =
    built.workflows.find((workflow) =>
      [...workflow.bundle.graph.nodes.values()].some((node) => node.component === component),
    ) ?? built.workflows[0];
  // the assembly rejects an application without workflows
  if (found === undefined)
    throw new TestSetupError({ message: "the application has no workflows" });
  return found;
}

/** The workflow of the application whose agents use a tool of this class. */
export function workflowWithTool(built: BuiltApplication, tool: Class): BuiltApp {
  const name = toolNameOf(tool);
  return (
    built.workflows.find((workflow) => workflow.app.hasTool(name)) ?? workflowWith(built, tool)
  );
}

/** One component on its own (`app.runAgent(X, …)`, `app.runRouter(R, …)`, `app.runTool(T, …)`). */
export const slicesOf = (
  environment: TestEnvironment,
  built: () => Promise<BuiltApplication>,
): Pick<TestApp, "runAction" | "runAgent" | "runRouter" | "runTool"> => ({
  runAction: (action, input) =>
    checked(environment, async () =>
      actionSlice(workflowWith(await built(), action), action).run(input),
    ),
  runAgent: (agent, task) =>
    checked(environment, async () =>
      agentSlice(workflowWith(await built(), agent), agent).replyWith(task),
    ),
  runRouter: (router, input) =>
    checked(environment, async () =>
      routerSlice(workflowWith(await built(), router), router).routeTo(input),
    ),
  runTool: (tool, input) =>
    checked(environment, async () =>
      toolSlice(workflowWithTool(await built(), tool), tool).invoke(input),
    ),
});

/**
 * What answers during and after `close()` too: the probes (an orchestrator asks while the app
 * stops), the audit log (#501: a test reads a stopped zombie's) and the outbound calls (#505: an
 * operator reads them after the instance stopped).
 */
export const probesOf = (
  environment: TestEnvironment,
  probed: () => Promise<BuiltApplication>,
): Pick<
  TestApp,
  | "checkLiveness"
  | "checkReadiness"
  | "auditLogOf"
  | "outboundCallsOf"
  | "pendingOutboundCallsOf"
  | "listPauses"
  | "getStatusHistory"
> => ({
  getStatusHistory: (threadId, options) =>
    checked(environment, async () => (await probed()).app.getStatusHistory(threadId, options)),
  checkLiveness: () => checked(environment, async () => (await probed()).app.checkLiveness()),
  checkReadiness: () => checked(environment, async () => (await probed()).app.checkReadiness()),
  auditLogOf: (tree) => checked(environment, async () => (await probed()).app.auditLogOf(tree)),
  outboundCallsOf: (tree) =>
    checked(environment, async () => (await probed()).app.outboundCallsOf(tree)),
  pendingOutboundCallsOf: (query) =>
    checked(environment, async () => (await probed()).app.pendingOutboundCallsOf(query)),
  listPauses: (query) => checked(environment, async () => (await probed()).app.listPauses(query)),
});

/** `execute` and `resume`: the call, its output kept as the test's last one (`answerPause` answers its pause). */
export const runsOf = (
  environment: TestEnvironment,
  built: () => Promise<BuiltApplication>,
): Pick<TestApp, "execute" | "resume"> => ({
  execute: (start, input, ...options) =>
    checked(environment, async () =>
      remembered(environment, await (await built()).app.execute(start, input, ...options)),
    ),
  resume: (request, options): Promise<ExecutionOutput> =>
    checked(environment, async () =>
      remembered(environment, await (await built()).app.resume(request, options)),
    ),
});
