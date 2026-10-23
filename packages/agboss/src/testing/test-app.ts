import type { BuiltApp } from "../app/create-app.js";
import type { BuiltApplication } from "../application/create-app.js";
import type { App, ExecutionOutput } from "../app/types.js";
import type { Class } from "../components/injection.js";
import type { VirtualClock } from "./clock.js";
import type { TestEnvironment } from "./environment.js";
import { TestFailure, TestSetupError } from "./errors.js";
import {
  agentSlice,
  routerSlice,
  toolSlice,
  type AgentSlice,
  type RouterSlice,
  type ToolClassOf,
  type ToolSlice,
} from "./slices.js";
import { toolNameOf } from "./script.js";
import { isListedProvider, rememberListedProviders } from "../application/listed-providers.js";

/**
 * The app of a test: the same `run` / `resume` as in production, built on first use (so `mockOf`
 * in the test body still takes effect), plus the test's clock and slices of single components.
 * A blocked live call or a script problem fails the call, even when the run swallowed it; any call
 * after `close()` (or `recoverApp()`) but the probes (#300) fails with `test.app-closed`.
 */
export interface TestApp extends Pick<
  App,
  "execute" | "resume" | "close" | "cancel" | "checkLiveness" | "checkReadiness" | "resolve"
> {
  readonly clock: VirtualClock;
  /**
   * Builds the test's application now (assembly, `onInit` → `onStart`), for a test that executes
   * nothing; the first `execute` builds it otherwise. A second call does nothing.
   */
  ready(): Promise<void>;
  agent(agent: Class): AgentSlice;
  router(router: Class): RouterSlice;
  tool<TInput, TOutput>(tool: ToolClassOf<TInput, TOutput>): ToolSlice<TInput, TOutput>;
}

/** Rethrows what the test must see: a reported failure wins over the run's own error. */
async function checked<T>(environment: TestEnvironment, work: () => Promise<T>): Promise<T> {
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

/** The workflow of the application a component is in (its first, for a shared one); else the first. */
function workflowWith(built: BuiltApplication, component: Class): BuiltApp {
  const found =
    built.workflows.find((workflow) =>
      [...workflow.bundle.graph.nodes.values()].some((node) => node.component === component),
    ) ?? built.workflows[0];
  // the assembly rejects an application without workflows
  if (found === undefined) throw new TestSetupError("the application has no workflows");
  return found;
}

/** The workflow of the application whose agents use a tool of this class. */
function workflowWithTool(built: BuiltApplication, tool: Class): BuiltApp {
  const name = toolNameOf(tool);
  return (
    built.workflows.find((workflow) => workflow.app.hasTool(name)) ?? workflowWith(built, tool)
  );
}

/**
 * The app once the module of its probes is loaded too (#300): in production it loads on the first
 * probe; in a test `checkReadiness()` followed at once by `clock.advance(…)` must find its timeouts
 * already waiting on the clock.
 */
async function withProbesLoaded(building: Promise<BuiltApplication>): Promise<BuiltApplication> {
  const [built] = await Promise.all([building, import("../health/application-health.js")]);
  return built;
}

/** The slices of single components (`app.agent(X)`, `app.router(R)`, `app.tool(T)`). */
const slicesOf = (
  environment: TestEnvironment,
  built: () => Promise<BuiltApplication>,
): Pick<TestApp, "agent" | "router" | "tool"> => ({
  agent: (agent) => ({
    replyWith: (task) =>
      checked(environment, async () =>
        agentSlice(workflowWith(await built(), agent), agent).replyWith(task),
      ),
  }),
  router: (router) => ({
    routeTo: (input) =>
      checked(environment, async () =>
        routerSlice(workflowWith(await built(), router), router).routeTo(input),
      ),
  }),
  tool: (tool) => ({
    invoke: (input) =>
      checked(environment, async () =>
        toolSlice(workflowWithTool(await built(), tool), tool).invoke(input),
      ),
  }),
});

export function createTestApp(environment: TestEnvironment): TestApp {
  let building: Promise<BuiltApplication> | undefined;
  /** The built application once `building` resolved: `resolve` reads it synchronously. */
  let ready: BuiltApplication | undefined;
  let closed = false;
  const built = (): Promise<BuiltApplication> => {
    if (closed) {
      const message = "this app is closed — after recoverApp() use the app it returned";
      return Promise.reject(new TestFailure("test.app-closed", message));
    }
    return (building ??= withProbesLoaded(environment.newApp()).then(
      (application) => (ready = application),
    ));
  };
  const probed = (): Promise<BuiltApplication> => building ?? built();
  const readyApp = (): App => {
    if (ready === undefined) {
      const message = "the app is not built yet — await app.ready() (or an execute) before resolve";
      throw new TestFailure("test.app-not-ready", message);
    }
    return ready.app;
  };
  const testApp: TestApp = {
    clock: environment.clock,
    execute: (start, input, ...options) =>
      checked(environment, async () => (await built()).app.execute(start, input, ...options)),
    resume: (request, options): Promise<ExecutionOutput> =>
      checked(environment, async () => (await built()).app.resume(request, options)),
    cancel: (thread, options) =>
      checked(environment, async () => (await built()).app.cancel(thread, options)),
    // the probes answer during and after close() too: an orchestrator asks while the app stops
    checkLiveness: () => checked(environment, async () => (await probed()).app.checkLiveness()),
    checkReadiness: () => checked(environment, async () => (await probed()).app.checkReadiness()),
    ready: () =>
      checked(environment, async () => {
        await built();
      }),
    resolve: (token) => readyApp().resolve(token),
    close: async (options) => {
      closed = true;
      if (building !== undefined) await (await building).app.close(options);
    },
    ...slicesOf(environment, built),
  };
  // a listener built from this app checks its providers like the built application's (#387)
  rememberListedProviders(testApp, (cls) => isListedProvider(readyApp(), cls) ?? false);
  return testApp;
}
