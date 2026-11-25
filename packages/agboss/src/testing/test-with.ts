import { test, type Mocked, type TestAPI, type TestContext } from "vitest";
import type { ApplicationClass } from "../application/types.js";
import type { Class } from "../components/injection.js";
import type { McpServerClient, ServerTools } from "../components/mcp-client.js";
import { TestEnvironment, type TestWithOptions } from "./environment.js";
import { testInstancesOf } from "./instances.js";
import type { McpStub } from "./mcp-stubs.js";
import { blockNetwork } from "./network-guard.js";
import type { ModelScript } from "./script-book.js";
import type { ActionScript } from "./action-script.js";
import type { ToolScript } from "./tool-script.js";
import { createTestApp, type TestApp } from "./test-app.js";
import type { VirtualClock } from "./clock.js";
import { TestSetupError } from "./errors.js";
import type { ExecutionOutput } from "../app/types.js";
import type { EvalPauseOptions } from "../eval/suite/pauses.js";
import { pauseAndBoundaryFixtures } from "./extra-fixtures.js";
import type { PauseOutputOf } from "../flow/generated-types.js";
import type { A2AServerFixture } from "./a2a-server.js";
import type { McpServerFixture } from "./mcp-server.js";
import type { A2AStub, RagStub } from "./boundary-stubs.js";
import { withTestLeases, type TestLeases } from "./leases.js";
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
   * `mockModel(Scout).thenReturn(replyWith("…"))`, `mockModel(AnswerGrounded).thenReturn(replyWith("PASS"))`.
   */
  readonly mockModel: <TComponent extends Class>(
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
  readonly mockService: <T>(component: Class<T>) => Mocked<T>;
  /** The stub of an MCP server: `mockMcp(ShortlistServer).thenReturn({ write_file: … })`. */
  readonly mockMcp: <TServer extends McpServerClient<ServerTools>>(
    server: new () => TServer,
  ) => McpStub<TServer>;
  /**
   * Answers the open pause of `target` the last `execute` / `resume` of the test left, with its
   * decision: `await answerPause(RefundApproval, { approved: true })` — the same call as an eval
   * case's, `{ actor }` being who answers (a thread owner's `ownerId`). The answer is the
   * resumed execution's output; a pause of no such target is `test.no-open-pause`.
   */
  readonly answerPause: <const TTarget extends Class>(
    target: TTarget,
    decision: PauseOutputOf<InstanceType<TTarget>>,
    options?: EvalPauseOptions,
  ) => Promise<ExecutionOutput>;
  /**
   * Answers the open pause of `target` with a free-text reply its channel interpreter reads
   * (`await replyToPause(RefundApproval, "yes, but only half")`); the rest as `answerPause`.
   */
  readonly replyToPause: (
    target: Class,
    reply: string,
    options?: EvalPauseOptions,
  ) => Promise<ExecutionOutput>;
  /**
   * The scripted retrievals of a knowledge base: `mockRag(Handbook).thenReturn({ results: [...] })` —
   * its pipeline (scope, reranking, PII policies, spend) still runs on what it returns.
   */
  readonly mockRag: (rag: Class) => RagStub;
  /** The scripted answers of an A2A peer the application calls: `mockA2A(BillingDesk).thenReturn({ … })`. */
  readonly mockA2A: (agent: Class) => A2AStub;
  /**
   * The application served as an MCP server (#1319), symmetric with `a2aServer`: `const { url } =
   * await mcpServer(ShortlistEndpoint, { authenticator })` — `mcpHttpListener(app, …)` on
   * `127.0.0.1:0`, the loopback open for the test, closed at its end.
   */
  readonly mcpServer: McpServerFixture;
  /**
   * The application served over A2A (#387): `const { url } = await a2aServer({ expose,
   * authenticator })` — `a2aHttpListener(app, …)` on `127.0.0.1:0`, the authenticator from the app's
   * container, the loopback open for the test (no `allowNetwork` needed), closed at its end.
   */
  readonly a2aServer: A2AServerFixture;
  /**
   * A frozen process (#471): `leases.freeze(apps[0])` stops that instance's lease store calls and
   * lease timers while its step code runs on, `leases.thaw(apps[0])` lets them go — with
   * `clock.advance(seconds(31))` between, another instance takes the lease over.
   */
  readonly leases: TestLeases;
}

/** How many app instances the test runs (#831: a count, or one entry per instance). */
const instancesOf = (options: TestWithOptions): number => testInstancesOf(options).length;

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
 * (`mockModel`), MCP servers stubbed (`mockMcp`), the network blocked (`allowNetwork` to open hosts),
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
      if (first === undefined)
        throw new TestSetupError({ message: "instances: the test runs no instance" });
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
    mockModel: async ({ environment }, use) => {
      await use((component) => environment.mockModel(component));
    },
    mockAction: async ({ environment }, use) => {
      await use((action) => environment.mocks.mockAction(action));
    },
    mockTool: async ({ environment }, use) => {
      await use((tool) => environment.mocks.mockTool(tool));
    },
    mockService: async ({ environment }, use) => {
      await use((component) => environment.mocks.mockService(component));
    },
    mockMcp: async ({ environment }, use) => {
      await use((server) => environment.mockMcp(server));
    },
    ...pauseAndBoundaryFixtures,
    leases: ({ environment }, use) => withTestLeases(environment, use),
  });
}
