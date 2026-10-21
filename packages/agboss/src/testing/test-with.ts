import { test, type Mocked, type TestAPI, type TestContext } from "vitest";
import type { ApplicationClass } from "../application/types.js";
import type { Class } from "../components/injection.js";
import type { McpServerClient, ServerTools } from "../components/mcp-client.js";
import { TestEnvironment, type TestWithOptions } from "./environment.js";
import type { McpStub } from "./mcp-stubs.js";
import { blockNetwork } from "./network-guard.js";
import type { ModelScript } from "./script-book.js";
import type { ActionScript } from "./action-script.js";
import type { ToolScript } from "./tool-script.js";
import { createTestApp, type TestApp } from "./test-app.js";
import type { VirtualClock } from "./clock.js";
import { TestSetupError } from "./errors.js";
import type { ModelTarget } from "./scripted-gateway.js";
import "./vitest-types.js";

/** What every test of `testWith(Application)` gets as its fixtures. */
export interface WorkflowFixtures {
  /** The application's real container and graphs, models and MCP scripted; built on first use. */
  readonly app: TestApp;
  /**
   * Every instance of the application (`testWith(App, { instances: 2 })`), `apps[0]` being `app`:
   * one container and instance id each, one set of stores and one clock for all.
   */
  readonly apps: readonly TestApp[];
  /**
   * The test's `VirtualClock`, shared by its instances: `await clock.advance(seconds(31))`. Always
   * this one, even when the application lists its own `Clock`: tests never run on real time.
   */
  readonly clock: VirtualClock;
  /**
   * Closes the current app (its `onStop` hooks run, as on a real stop) and returns a new one over
   * the same test state (checkpoints, ledger, clock, ids) — "a paused run survives a restart".
   * The closed app fails every call with `test.app-closed`.
   */
  readonly recoverApp: () => Promise<TestApp>;
  /**
   * The script of an agent, a router or a `@Judge`'s model (by class):
   * `mockLlm(Scout).thenReturn(replyWith("…"))`, `mockLlm(AnswerGrounded).thenReturn(replyWith("PASS"))`.
   */
  readonly mockLlm: <TComponent extends ModelTarget>(
    component: TComponent,
  ) => ModelScript<InstanceType<TComponent>>;
  /**
   * The recorded calls of an action — it still runs: `mockAction(NotifyRecruiterAction).inputs`,
   * `expect(mockAction(A)).toHaveBeenCalledWith({ draft: { title: "…" } })` (#262 AC9).
   */
  readonly mockAction: <TAction extends Class>(
    action: TAction,
  ) => ActionScript<InstanceType<TAction>>;
  /**
   * The scripted failures of a tool: `mockTool(SearchJobsTool).thenFail(ToolFailure.Timeout)` —
   * the next call fails as a real timeout would; the calls after the failures run the tool.
   */
  readonly mockTool: (tool: Class) => ToolScript;
  /** A typed mock injected instead of a component; the same instance the app uses. */
  readonly mockOf: <T>(component: Class<T>) => Mocked<T>;
  /** The stub of an MCP server: `mcpOf(ShortlistServer).thenReturn({ write_file: … })`. */
  readonly mcpOf: <TServer extends McpServerClient<ServerTools>>(
    server: new () => TServer,
  ) => McpStub<TServer>;
}

/** How many app instances the test runs: a whole number ≥ 1 (default 1). */
function instancesOf(options: TestWithOptions): number {
  const count = options.instances ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new TestSetupError(`instances: ${String(count)} — a whole number ≥ 1`);
  }
  return count;
}

/**
 * The test's environment, the network blocked around it; its apps closed after the test. A test
 * whose body passed fails on what it scripted and never used (#262 AC7); one that already failed
 * reports its own failure only.
 */
async function withEnvironment(
  testSetup: Internal["testSetup"],
  task: TestContext["task"],
  use: (environment: TestEnvironment) => Promise<void>,
): Promise<void> {
  const environment = await TestEnvironment.of(testSetup.application, testSetup.options);
  const unblock = blockNetwork({
    allowed: testSetup.options.allowNetwork ?? [],
    onBlocked: (error) => environment.book.report(error),
  });
  try {
    await use(environment);
  } finally {
    unblock();
    await environment.close();
  }
  const leftovers = task.result?.state === "fail" ? undefined : environment.book.leftoverFailure();
  if (leftovers !== undefined) throw leftovers;
}

interface Internal {
  readonly testSetup: { readonly application: Class; readonly options: TestWithOptions };
  readonly environment: TestEnvironment;
}

/**
 * A Vitest `test` for an application, like Spring's test context — the only form (#261): each test
 * gets the whole application assembled, with its real container, components, graph rules and the
 * infrastructure it lists (else the in-memory defaults), new per test, as `app`; models scripted
 * (`mockLlm`), MCP servers stubbed (`mcpOf`), the network blocked (`allowNetwork` to open hosts),
 * deterministic ids and a controllable clock. One workflow is tested through its start with
 * `app.execute`. `onStop` of real components runs after the test, also when it failed.
 * `const test = testWith(JobScoutApplication)`.
 */
export function testWith<TApplication extends Class>(
  application: ApplicationClass<TApplication>,
  options: TestWithOptions = {},
): TestAPI<WorkflowFixtures> {
  return test.extend<Internal & WorkflowFixtures>({
    testSetup: { application, options },
    environment: [
      ({ testSetup, task }, use) => withEnvironment(testSetup, task, use),
      { auto: true },
    ],
    apps: async ({ environment, testSetup }, use) => {
      const count = instancesOf(testSetup.options);
      await use(Array.from({ length: count }, () => createTestApp(environment)));
    },
    app: async ({ apps }, use) => {
      const [first] = apps;
      if (first === undefined) throw new TestSetupError("instances: the test runs no instance");
      await use(first);
    },
    clock: async ({ environment }, use) => {
      await use(environment.clock);
    },
    recoverApp: async ({ environment, app }, use) => {
      let current = app;
      await use(async () => {
        await current.close();
        current = createTestApp(environment);
        return current;
      });
    },
    mockLlm: async ({ environment }, use) => {
      await use((component) => environment.mockLlm(component));
    },
    mockAction: async ({ environment }, use) => {
      await use((action) => environment.mocks.mockAction(action));
    },
    mockTool: async ({ environment }, use) => {
      await use((tool) => environment.mocks.mockTool(tool));
    },
    mockOf: async ({ environment }, use) => {
      await use((component) => environment.mocks.mockOf(component));
    },
    mcpOf: async ({ environment }, use) => {
      await use((server) => environment.mcpOf(server));
    },
  });
}
