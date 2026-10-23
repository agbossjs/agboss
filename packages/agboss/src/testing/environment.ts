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
import type { RuntimeNode } from "../flow/runtime/graph-model.js";
import { VirtualClock } from "./clock.js";
import { SequentialIdGenerator } from "./id-generator.js";
import { TestSetupError } from "./errors.js";
import { McpStubs, stubbedMcpConnect, type McpStub } from "./mcp-stubs.js";
import { ScriptBook, type ModelScript } from "./script-book.js";
import { createScriptedGateway, type ModelTarget } from "./scripted-gateway.js";
import { ModelTargets, scriptKeyOf } from "./model-targets.js";
import { mcpServersOf, usedComponentsOf } from "./workflow-parts.js";
import { TestMocks } from "./test-mocks.js";
import { reusableInfrastructure } from "../infrastructure/contracts.js";
import { InMemoryDatabase } from "../infrastructure/in-memory-database.js";
import { createVcrGateway, type VcrConfig } from "./vcr.js";
import { testPiiKeyOf, testPseudonymKeys } from "./pii-parts.js";
import { schedulerOf } from "./concurrency/schedulers.js";
import { replacementsOf, type Override } from "./units/override.js";
import type { TestConcurrency } from "./concurrency/test-concurrency.js";

/** The app option of a test's branch schedule: none for `TestConcurrency.Real`. */
function branchSchedulerOf(
  concurrency: TestConcurrency | undefined,
  book: ScriptBook,
): Pick<AppDepsOptions, "branchScheduler"> {
  const branchScheduler = schedulerOf(concurrency, book);
  return branchScheduler === undefined ? {} : { branchScheduler };
}

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
  /**
   * How parallel branches run (#262 S33): `TestConcurrency.Sequential` (default — one at a time,
   * in listed / item order), `TestConcurrency.Real`, or `TestConcurrency.inOrder([step(A), …])`.
   */
  readonly concurrency?: TestConcurrency;
  /**
   * Classes the application's container creates instead of others (#262, #267 S104):
   * `[override(RefundApprovalRole, AutoApproveChannel)]` — the same `override(…)` as the unit runners.
   */
  readonly overrides?: readonly Override[];
}

/** The process env without tracing keys: tests never export traces. */
const testEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("LANGFUSE_")));

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
  /** The test's ids (#313): `thread-1`, `execution-1`, … unless the application lists its own. */
  readonly idGenerator = new SequentialIdGenerator();
  readonly mcp = new McpStubs(this.book);
  /** The rows of the in-memory defaults, shared by every app instance of the test. */
  readonly database = new InMemoryDatabase();
  /** `mockOf`, `mockTool`, `mockAction`: what the test replaces or watches. */
  readonly mocks: TestMocks;
  readonly #apps: BuiltApplication[] = [];
  readonly #nodes: readonly RuntimeNode[];
  readonly #used: ReadonlySet<Class>;
  readonly #targets: ModelTargets;
  readonly #servers: ReadonlyMap<Class, string>;
  readonly #options: AppDepsOptions;
  /** The PII key of its instances when the application sets none (#334). */
  readonly #piiTestKey: string | undefined;
  #reused: ReadonlyMap<Class, unknown> = new Map();
  /** The app being built: instances are built one after the other, the first one's stores kept. */
  #building: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly assembled: AssembledApplication,
    options: TestWithOptions,
    environment: NamedEnvironment,
  ) {
    const { workflows } = assembled;
    this.#nodes = workflows.flatMap((workflow) => [...workflow.graph.nodes.values()]);
    this.#used = usedComponentsOf(assembled);
    this.#targets = new ModelTargets(assembled, this.#nodes);
    this.mocks = new TestMocks(this.book, this.#nodes, this.#used);
    for (const node of this.#nodes) {
      const key = scriptKeyOf(node);
      if (key !== undefined) this.book.name(key, node.component.name);
    }
    this.#servers = mcpServersOf(assembled);
    this.#piiTestKey = testPiiKeyOf(options);
    const real = realServers(this.#servers, options.real ?? []);
    const labels = new Map([...this.#servers].map(([cls, name]) => [name, cls.name] as const));
    this.#options = {
      processEnv: { ...testEnv(), ...testPseudonymKeys(assembled, testEnv()) },
      ...environment,
      gateway: options.vcr
        ? createVcrGateway(workflows, options.vcr, { env: testEnv(), ...environment }, (failure) =>
            this.book.report(failure),
          )
        : createScriptedGateway(this.book, this.clock),
      connectMcp: stubbedMcpConnect(this.mcp, labels, real),
      container: { ...this.mocks.container, replacements: replacementsOf(options.overrides) },
      ...branchSchedulerOf(options.concurrency, this.book),
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
    this.mocks.started();
    const building = this.#building.then(async () => {
      const seams = {
        reused: this.#reused,
        instanceId: `instance-${String(this.#apps.length + 1)}`,
        database: this.database,
        clock: this.clock,
        idGenerator: this.idGenerator,
        quiet: true,
        ...(this.#piiTestKey === undefined ? {} : { piiTestKey: this.#piiTestKey }),
        observers: [this.mocks.actions],
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
    const component = this.#targets.componentKeyOf(target);
    if (component !== undefined) {
      this.book.name(component, label);
      return this.book.scriptOf(component);
    }
    const node = this.#nodes.find((item) => item.component === target);
    const key = node === undefined ? undefined : scriptKeyOf(node);
    if (key === undefined)
      throw new TestSetupError(`mockLlm(${label}): ${this.#targets.whyNoScript(target)}`);
    return this.book.scriptOf(key);
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
