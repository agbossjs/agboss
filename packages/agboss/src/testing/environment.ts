import type { Mocked } from "vitest";
import type { AppDepsOptions } from "../app/app-deps.js";
import { applicationOf, type AssembledApplication } from "../application/assemble.js";
import {
  buildApplication,
  environmentOwnerOf,
  type BuiltApplication,
} from "../application/create-app.js";
import {
  namedEnvironmentFor,
  TEST_DEFAULT_ENVIRONMENT,
  type EnvironmentSelection,
  type NamedEnvironment,
} from "../environments/load.js";
import type { Class } from "../components/injection.js";
import type { McpServerClient, ServerTools } from "../components/mcp-client.js";
import { NodeKind } from "../flow/ast.js";
import { isCodeRouterNode, type RuntimeNode } from "../flow/runtime/graph-model.js";
import { VirtualClock } from "./clock.js";
import { TestSetupError } from "./errors.js";
import { McpStubs, stubbedMcpConnect, type McpStub } from "./mcp-stubs.js";
import { mockInstanceOf } from "./mocks.js";
import { ScriptBook, type ModelScript } from "./script-book.js";
import {
  createScriptedGateway,
  judgeScriptKeyOf,
  routerKeyOf,
  type ModelTarget,
} from "./scripted-gateway.js";
import { mcpServersOf, usedComponentsOf } from "./workflow-parts.js";
import { reusableInfrastructure } from "../infrastructure/contracts.js";
import { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import { createVcrGateway, type VcrConfig } from "./vcr.js";

/**
 * What `testWith` takes besides the application. `env` names the environment (default `test`: a
 * test never falls back to dev's values, and fails without `test.environment.ts`).
 */
export interface TestWithOptions extends EnvironmentSelection {
  /** Components kept real: MCP server classes connect through their configured transports. */
  readonly real?: readonly Class[];
  /** Hosts a test may reach (`localhost` covers every loopback address); everything else is blocked. */
  readonly allowNetwork?: readonly string[];
  /**
   * Models answer from a recorded cassette instead of scripts: recorded once with real models,
   * replayed in every later run (REPLAY by default under `CI`: no key, no network).
   */
  readonly vcr?: VcrConfig;
  /**
   * How many application instances the test runs (default 1): `apps[0]` (= `app`) … `apps[n-1]`,
   * each with its own container and instance id, over one set of stores and one clock — so a
   * lease, a pause resumed on the other instance or a rate-limit slot is tested across instances.
   */
  readonly instances?: number;
}

/** The process env without tracing keys: tests never export traces. */
const testEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANGFUSE_")));

/** The script key of a node that calls a model (an agent or a model router; a code router calls none). */
function scriptKeyOf(node: RuntimeNode): string | undefined {
  if (node.kind === NodeKind.Agent) return `agent:${node.id}`;
  if (node.kind === NodeKind.Router && !isCodeRouterNode(node)) return routerKeyOf(node.id);
  return undefined;
}

/** The names of the MCP servers kept real; anything else in `real` is a setup error. */
function realServers(servers: ReadonlyMap<Class, string>, real: readonly Class[]): Set<string> {
  return new Set(
    real.map((cls) => {
      const name = servers.get(cls);
      if (name === undefined) {
        throw new TestSetupError(`real: [${cls.name}] — not an MCP server of this application`);
      }
      return name;
    }),
  );
}

/**
 * Everything one test owns: scripts, mocks, MCP stubs, a controllable clock and deterministic ids —
 * and the application's infrastructure (the implementations it lists, else the in-memory
 * defaults), created by the first app of the test and kept by every later one, so an execution
 * resumed after `recoverApp()` continues; never shared between tests.
 */
export class TestEnvironment {
  readonly book = new ScriptBook();
  readonly clock = new VirtualClock();
  readonly mcp = new McpStubs(this.book);
  /** The rows of the in-memory defaults, shared by every app instance of the test. */
  readonly database = new InMemoryDatabase();
  readonly #mocks = new Map<Class, unknown>();
  readonly #apps: BuiltApplication[] = [];
  readonly #nodes: readonly RuntimeNode[];
  readonly #used: ReadonlySet<Class>;
  readonly #judges: ReadonlySet<string>;
  readonly #servers: ReadonlyMap<Class, string>;
  readonly #options: AppDepsOptions;
  #reused: ReadonlyMap<Class, unknown> = new Map();
  /** The app being built: instances are built one after the other, the first one's stores kept. */
  #building: Promise<unknown> = Promise.resolve();
  #threads = 0;
  #runs = 0;

  private constructor(
    readonly assembled: AssembledApplication,
    options: TestWithOptions,
    environment: NamedEnvironment,
  ) {
    const { workflows } = assembled;
    this.#nodes = workflows.flatMap((workflow) => [...workflow.graph.nodes.values()]);
    this.#used = usedComponentsOf(assembled);
    this.#judges = new Set(
      workflows.flatMap((workflow) => Object.keys(workflow.config.judges ?? {})),
    );
    for (const node of this.#nodes) {
      const key = scriptKeyOf(node);
      if (key !== undefined) this.book.name(key, node.component.name);
    }
    this.#servers = mcpServersOf(assembled);
    const real = realServers(this.#servers, options.real ?? []);
    const labels = new Map([...this.#servers].map(([cls, name]) => [name, cls.name] as const));
    const [first] = workflows;
    this.#options = {
      processEnv: testEnv(),
      ...environment,
      gateway:
        options.vcr && first !== undefined
          ? createVcrGateway(first, options.vcr, testEnv(), (failure) => this.book.report(failure))
          : createScriptedGateway(this.book),
      connectMcp: stubbedMcpConnect(this.mcp, labels, real),
      newThreadId: () => {
        this.#threads += 1;
        return `thread-${String(this.#threads)}`;
      },
      newRunId: () => {
        this.#runs += 1;
        return `run-${String(this.#runs)}`;
      },
      container: { overrides: this.#mocks },
    };
  }

  /**
   * Assembles the application and resolves its environment once up front (`test` unless `env`
   * names another): every assembly error, a missing environment or variable fails the test before
   * it runs.
   */
  static async of(application: Class, options: TestWithOptions = {}): Promise<TestEnvironment> {
    const assembled = await applicationOf(application, {}, "testWith");
    const environment = await namedEnvironmentFor(
      environmentOwnerOf(assembled),
      options,
      testEnv(),
      TEST_DEFAULT_ENVIRONMENT,
    );
    return new TestEnvironment(assembled, options, environment);
  }

  /**
   * A new app instance over this test's state: the real container and graphs, models and MCP
   * servers scripted, the infrastructure of the first app kept.
   */
  newApp(): Promise<BuiltApplication> {
    const building = this.#building.then(async () => {
      const seams = {
        reused: this.#reused,
        instanceId: `instance-${String(this.#apps.length + 1)}`,
        database: this.database,
        clock: this.clock,
        quiet: true,
      };
      const built = await buildApplication(this.assembled, this.#options, seams);
      if (this.#apps.length === 0) this.#reused = reusableInfrastructure(built.infrastructure);
      this.#apps.push(built);
      return built;
    });
    this.#building = building.catch(() => undefined);
    return building;
  }

  mockLlm(target: ModelTarget): ModelScript {
    const label = target.name;
    const judge = judgeScriptKeyOf(target, this.#judges);
    if (judge !== undefined) {
      this.book.name(judge, label);
      return this.book.scriptOf(judge);
    }
    const node = this.#nodes.find((item) => item.component === target);
    const key = node === undefined ? undefined : scriptKeyOf(node);
    if (key === undefined) {
      const why =
        node !== undefined && isCodeRouterNode(node)
          ? "a code router calls no model — mockOf() the services its route() uses"
          : "not an agent, router or judge of this application";
      throw new TestSetupError(`mockLlm(${label}): ${why}`);
    }
    return this.book.scriptOf(key);
  }

  mockOf<T>(cls: Class<T>): Mocked<T> {
    const existing = this.#mocks.get(cls);
    // the mock stored for this class was created by mockInstanceOf(cls) below
    if (existing !== undefined) return existing as Mocked<T>;
    if (!this.#used.has(cls)) {
      throw new TestSetupError(`mockOf(${cls.name}): not a component of this application`);
    }
    if (this.#apps.length > 0) {
      throw new TestSetupError(
        `mockOf(${cls.name}) after the app started: call it before the first app.execute(…)`,
      );
    }
    const mock = mockInstanceOf(cls);
    this.#mocks.set(cls, mock);
    return mock;
  }

  mcpOf<TServer extends McpServerClient<ServerTools>>(server: new () => TServer): McpStub<TServer> {
    const name = this.#servers.get(server);
    if (name === undefined) {
      throw new TestSetupError(`mcpOf(${server.name}): not an MCP server of this application`);
    }
    return this.mcp.stubOf<TServer>(name);
  }

  /** Closes every app (their `onStop` hooks). */
  async close(): Promise<void> {
    for (const built of this.#apps) await built.app.close();
  }
}
