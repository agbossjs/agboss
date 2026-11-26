import { ComponentKind } from "../flow/runtime/records.js";
import type { UnitRun } from "./units/unit-types.js";
import type { TestRunOptions, ToolClassOf } from "./slices.js";
import { Application, type ApplicationOptions } from "../application/application.js";
import type { Class, Resolved, Token } from "../components/injection.js";
import type { McpServerClient, ServerTools } from "../components/mcp-client.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { ToolOutput } from "../tools/index.js";
import type { Mocked } from "vitest";
import type { A2AStub, RagStub } from "./boundary-stubs.js";
import type { VirtualClock } from "./clock.js";
import { TestEnvironment, type TestWithOptions } from "./environment.js";
import type { McpStub } from "./mcp-stubs.js";
import type { ModelScript } from "./script-book.js";
import type { ActionScript } from "./action-script.js";
import { TestSetupError } from "./errors.js";
import type { ToolScript } from "./tool-script.js";
import { createTestApp, type TestApp } from "./test-app.js";

/**
 * `testModule({ components })` (#1328): a slice of an application — the workflows and the services
 * you list, nothing else — assembled together on one container, one `VirtualClock` and one set of
 * stores, as `testWith` assembles a whole application. The same scripted models, the same blocked
 * network; `runAgent` / `runAction` / `runTool` / `runRouter` run one component of the slice on its
 * own, as the app's slices do.
 */

/** The `@Application` options a module takes besides its components. */
export type TestModuleApplicationOptions = Partial<
  Omit<ApplicationOptions, "name" | "version" | "workflows" | "providers" | "services">
>;

/** What a module is assembled from: its components, the application's options, the test's. */
export interface TestModuleOptions extends TestWithOptions, TestModuleApplicationOptions {
  /**
   * The workflows of the slice and the infrastructure and services they use (`@Injectable`, stores,
   * model providers): a workflow goes to the application's `workflows`, every other class to its `providers`.
   */
  readonly components: readonly Class[];
}

/** One slice of an application under test. */
export interface TestModule {
  /** The module's one clock: `await module.clock.advance(seconds(31))`. */
  readonly clock: VirtualClock;
  /** The module's app, for what the slices do not cover (`execute`, `resume`, `cancel`). */
  readonly app: TestApp;
  /** The agent's reply to an input message: its text, or its answer's JSON. */
  runAgent(agent: Class, input: string, options?: TestRunOptions): Promise<UnitRun<string>>;
  /** The action's `execute(input)`, in a step's frame. */
  runAction(action: Class, input: unknown, options?: TestRunOptions): Promise<UnitRun<unknown>>;
  /** The tool as an agent gets it: validated, with its timeout, errors as results. */
  runTool<TInput, TOutput>(
    tool: ToolClassOf<TInput, TOutput>,
    input: TInput,
    options?: TestRunOptions,
  ): Promise<UnitRun<ToolOutput<TOutput>>>;
  /** The component a router chooses for an input message. */
  runRouter(router: Class, input: string, options?: TestRunOptions): Promise<UnitRun<Class>>;
  /** What the module's container holds for a token. */
  get<TToken extends Token>(token: TToken): Resolved<TToken>;
  /** The script of an agent, a router or a `@Judge`'s model (by class). */
  mockModel<TComponent extends Class>(component: TComponent): ModelScript<InstanceType<TComponent>>;
  mockTool(tool: Class): ToolScript;
  mockAction(action: Class): ActionScript;
  mockService<T>(service: Class<T>): Mocked<T>;
  mockMcp<TServer extends McpServerClient<ServerTools>>(
    server: new () => TServer,
  ): McpStub<TServer>;
  mockRag(rag: Class): RagStub;
  mockA2A(agent: Class): A2AStub;
  /** Closes the module's app (its `onStop` hooks run); a script that no call used then fails the test. */
  close(): Promise<void>;
}

const isWorkflow = (component: Class): boolean =>
  declarationOf(component)?.kind === ComponentKind.Workflow;

/** The test application the components make: a fresh class, never shared between modules. */
function applicationOf(options: TestModuleOptions): Class {
  const { components, ...rest } = options;
  const workflows = components.filter(isWorkflow);
  if (workflows.length === 0)
    throw new TestSetupError({
      message:
        "testModule: list at least one @Workflow in components — an agent, a router, a tool and an action run inside the workflow that has it",
    });
  const application = ApplicationOptionsOf(rest);
  class TestModuleApplication {
    readonly components = components;
  }
  Application({
    ...application,
    name: "test-module-application",
    version: "0.0.0",
    workflows,
    providers: components.filter((component) => !isWorkflow(component)),
  })(TestModuleApplication);
  return TestModuleApplication;
}

/** The keys of the options that are the `@Application`'s, not the test's. */
const APPLICATION_KEYS = [
  "promptVariables",
  "channels",
  "channelSelectors",
  "channelListeners",
  "storage",
  "budgets",
  "observers",
  "healthChecks",
  "modelProvider",
  "retention",
  "tenantContext",
  "executionContext",
  "piiPolicies",
  "guardrails",
  "toolInterceptors",
  "defaults",
  "executionLimits",
  "mesh",
  "exposes",
] as const;

/** The `@Application` options among a module's. */
function ApplicationOptionsOf(options: Omit<TestModuleOptions, "components">) {
  const found: Record<string, unknown> = {};
  for (const key of APPLICATION_KEYS) {
    if (key in options) found[key] = (options as Record<string, unknown>)[key];
  }
  return found as TestModuleApplicationOptions;
}

/**
 * A module of `components`, its environment assembled (every assembly error fails here). Close it at
 * the end of the test (`afterEach`): scripts nothing used fail it then.
 */
export async function testModule(options: TestModuleOptions): Promise<TestModule> {
  const environment = await TestEnvironment.of(applicationOf(options), options);
  const app = createTestApp(environment);
  return {
    clock: environment.clock,
    app,
    runAgent: (agent, input, call) => app.runAgent(agent, input, call),
    runAction: (action, input, call) => app.runAction(action, input, call),
    runTool: (tool, input, call) => app.runTool(tool, input, call),
    runRouter: (router, input, call) => app.runRouter(router, input, call),
    get: (token) => app.get(token),
    mockModel: (component) => environment.mockModel(component),
    mockTool: (tool) => environment.mocks.mockTool(tool),
    mockAction: (action) => environment.mocks.mockAction(action),
    mockService: (service) => environment.mocks.mockService(service),
    mockMcp: (server) => environment.mockMcp(server),
    mockRag: (rag) => environment.mocks.mockRag(rag),
    mockA2A: (agent) => environment.mocks.mockA2A(agent),
    close: async () => {
      await app.close();
      await environment.close();
      const leftovers = environment.book.leftoverFailure();
      if (leftovers !== undefined) throw leftovers;
    },
  };
}
