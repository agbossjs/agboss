import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAppDeps, type AppDeps } from "../src/app/app-deps.js";
import { workflowOf } from "../src/components/assemble.js";
import type { Class } from "../src/components/injection.js";
import { MODEL_MAX, type AgentsConfigOf } from "../src/config/types.js";
import type { UsageRecord } from "../src/finops/usage.js";
import type { SpendLedger } from "../src/finops/ledger.js";
import type { WorkflowDefaults } from "../src/flow/decorators/workflow.js";
import type { JevClient } from "../src/llm/jev-client.js";
import type { ModelFactory } from "../src/llm/registry.js";
import { createModelGateway, type ModelGateway } from "../src/llm/gateway.js";
import type { RouteRequest } from "../src/routers/index.js";
import { runAgent } from "../src/run/run-agent.js";
import type { AgentExecutionOutput, RunDeps, RunOptions } from "../src/run/types.js";
import { createSqliteTernStore, type TernStore } from "../src/terns/index.js";
import { StarWorkflow } from "./fixtures/test-flow/star.workflow.js";

export type TestAgent = "alpha" | "beta";

/** The router model of `testConfig` (Jev). */
export const testRouter = { kind: "jev", model: "typesafe/jev-test" } as const;

/** A config of two agents, for units that take a config (the star workflow has the same agents). */
export const testConfig: AgentsConfigOf<TestAgent> = {
  name: "test-bundle",
  version: "1.0.0",
  defaults: {
    models: { temperature: 0, maxTokens: MODEL_MAX, thinking: "default", cache: true },
    router: testRouter,
    tools: { maxToolCalls: 3 },
    history: { limit: 2 },
  },
  agents: {
    alpha: {
      model: "test/alpha",
      description: "Handles alpha work",
      price: { inputPerMTok: 3, outputPerMTok: 6 },
    },
    beta: {
      model: "test/beta",
      description: "Handles beta work",
      price: { inputPerMTok: 3, outputPerMTok: 6 },
    },
  },
};

/** `@Workflow({ defaults })` of the test workflows (the same defaults as `testConfig`). */
export { StarWorkflow };

export const testDefaults: WorkflowDefaults = {
  models: { temperature: 0, maxTokens: MODEL_MAX, cache: true },
  router: { model: "typesafe/jev-test" },
  tools: { maxToolCalls: 3 },
  history: { limit: 2 },
};

/** Scripted responses per model slug. */
export type ModelScript = Readonly<Record<string, string[]>>;

/** A scripted chat model whose provider reports each call as free (a router's model has no price). */
class FreeFakeChatModel extends FakeListChatModel {
  override async _generate(
    ...args: Parameters<FakeListChatModel["_generate"]>
  ): Promise<ChatResult> {
    const result = await super._generate(...args);
    for (const generation of result.generations) {
      generation.message.response_metadata = { usage: { cost: 0 } };
    }
    return result;
  }
}

/** Scripted chat models by slug; a model without a price reports its calls as free. */
export const fakeChatFactory =
  (script: ModelScript): ModelFactory =>
  (settings) => {
    const responses = script[settings.model] ?? [];
    return settings.price === undefined
      ? new FreeFakeChatModel({ responses })
      : new FakeListChatModel({ responses });
  };

export const unusedJevClient: JevClient = () => Promise.reject(new Error("jev not used"));

/** The default gateway over fake clients: chat models from `chatModel`, Jev from `jevClient`. */
export const fakeGateway = (
  chatModel: ModelFactory,
  jevClient: JevClient = unusedJevClient,
): ModelGateway => createModelGateway({ chatModel, jevClient });

/** In-memory ledger: starts at `spentToday`, remembers what runs record. */
export function memoryLedger(spentToday = 0): SpendLedger & { readonly recorded: UsageRecord[] } {
  const recorded: UsageRecord[] = [];
  return {
    recorded,
    spentToday: () =>
      Promise.resolve(spentToday + recorded.reduce((sum, record) => sum + record.costUsd, 0)),
    record: (_bundle, records) => {
      recorded.push(...records);
      return Promise.resolve();
    },
  };
}

/** What `fakeDeps` may be given instead of its defaults. */
export interface FakeDepsOptions {
  readonly ledger?: SpendLedger;
  readonly terns?: TernStore;
  readonly workflow?: Class;
  readonly newRunId?: () => string;
  /** Chat models instead of the script's (e.g. a `ScriptedChatModel` with tool calls). */
  readonly chatModel?: ModelFactory;
  /** Jev's answers (the default router, `ROUTER_FACTORY`); default: Jev is not used. */
  readonly jevClient?: JevClient;
}

/**
 * The run dependencies of a test workflow (default: the star) with every chat model scripted by
 * slug: "test/router" answers with `routeTo(…)`, "test/alpha" and "test/beta" with text.
 */
export async function fakeDeps(
  script: ModelScript,
  options: FakeDepsOptions = {},
): Promise<AppDeps> {
  const deps = await createAppDeps(await workflowOf(options.workflow ?? StarWorkflow), {
    gateway: fakeGateway(options.chatModel ?? fakeChatFactory(script), options.jevClient),
    processEnv: {},
    ...(options.newRunId === undefined ? {} : { newRunId: options.newRunId }),
  });
  // the unit tests read and share these stores themselves: the run's ledger and records
  const ledger = options.ledger ?? memoryLedger();
  const terns = options.terns ?? createSqliteTernStore(":memory:");
  return { ...deps, ledger, terns, evaluation: { ...deps.evaluation, ledger, terns } };
}

/** Runs the star's chat start with a text (on the thread given, else a new one). */
export const runText = (
  text: string,
  deps: RunDeps<string>,
  options: RunOptions & { readonly threadId?: string } = {},
): Promise<AgentExecutionOutput> =>
  runAgent(
    {
      start: "chat-workflow-start",
      input: { text },
      ...(options.threadId === undefined ? {} : { threadId: options.threadId }),
    },
    deps,
    options,
  );

/** A chat-model router's answer: the route it takes. */
export const routeTo = (next: string, reason = "test"): string => JSON.stringify({ next, reason });

export const usageRecord = (caller: string, costUsd: number): UsageRecord => ({
  caller,
  model: "test/m",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: "price-table",
});

/** The deps with every router request recorded (what the routers saw, in order). */
export function recordingRouters<TDeps extends RunDeps<string>>(
  deps: TDeps,
): { readonly deps: TDeps; readonly requests: RouteRequest[] } {
  const requests: RouteRequest[] = [];
  const routerFor: TDeps["routerFor"] = (loaded) => {
    const router = deps.routerFor(loaded);
    return {
      name: router.name,
      route: (request) => {
        requests.push(request);
        return router.route(request);
      },
    };
  };
  return { deps: { ...deps, routerFor }, requests };
}
