import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { createAppDeps, type AppDeps } from "../src/app/app-deps.js";
import { workflowOf } from "../src/components/assemble.js";
import type { Class } from "../src/components/injection.js";
import { MODEL_MAX, type AgentsConfigOf } from "../src/config/types.js";
import type { UsageRecord } from "../src/finops/usage.js";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
  type CostCounter,
} from "../src/infrastructure/cost-ledger.repository.js";
import { Budget, BudgetScope, type BudgetHandler } from "../src/budgets/budget.js";
import type { ApplicationBudgets } from "../src/budgets/execution-budgets.js";
import { usd, type Usd } from "../src/units/index.js";
import { systemClock } from "../src/infrastructure/clock.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "./flow/fixtures/budgets.js";
import type { WorkflowDefaults } from "../src/flow/decorators/workflow.js";
import type { JevClient } from "../src/llm/jev-client.js";
import type { ModelFactory } from "../src/llm/registry.js";
import { createModelGateway, type ModelGateway } from "../src/llm/gateway.js";
import type { RouteRequest } from "../src/routers/index.js";
import { runAgent } from "../src/run/run-agent.js";
import { resumeAgent } from "../src/run/resume-agent.js";
import { treeResumeNow } from "../src/app/tree-resume.js";
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
    uncompactedTurns: 2,
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

/** The in-memory cost ledger, remembering every call it counted (once per call, over all counters). */
export class RecordingCostLedger extends InMemoryCostLedgerRepository {
  readonly recorded: UsageRecord[] = [];

  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly UsageRecord[],
  ): Promise<void> {
    this.recorded.push(...records);
    await super.saveAll(counters, records);
  }
}

/** A cost ledger that remembers what executions record. */
export const memoryLedger = (): RecordingCostLedger => new RecordingCostLedger();

/** A default execution budget of `amount` USD (a constant, as a test application lists one). */
export function executionBudgetOf(amount: number): Class<BudgetHandler> {
  @Budget({ name: "test-execution-budget", scope: BudgetScope.Execution })
  class AmountExecutionBudget implements BudgetHandler {
    maxSpend(): Usd {
      return usd(amount);
    }
  }
  return AmountExecutionBudget;
}

/** What `fakeDeps` may be given instead of its defaults. */
export interface FakeDepsOptions {
  /** Where the budgets count; default a new `RecordingCostLedger`. */
  readonly ledger?: CostLedgerRepository;
  /** The default execution budget, USD (default 1); the tenant's and the application's are $1000 a day. */
  readonly executionBudget?: number;
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
  // the unit tests read and share these stores themselves: the budgets' ledger and the records
  const budgets: ApplicationBudgets = {
    budgets: [
      TestApplicationDailyBudget,
      TestTenantDailyBudget,
      executionBudgetOf(options.executionBudget ?? 1),
    ],
    applicationName: "test-application",
    resolve: (budget) => deps.container.get(budget as Class<BudgetHandler>),
    ledger: options.ledger ?? memoryLedger(),
    clock: systemClock,
  };
  const terns = options.terns ?? createSqliteTernStore(":memory:", () => new Date());
  return { ...deps, budgets, terns, evaluation: { ...deps.evaluation, budgets, terns } };
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

/**
 * A resume of a run on its own (no app, #267 S35): the decision recorded on the run's first pending
 * pause (`Pending → Resolved`, answered by `answerer`), then the run moved with the tree's answers.
 * A run that is no longer paused moves with none — `resumeAgent` refuses it (`NotPausedError`).
 */
export async function resumeWith(
  paused: AgentExecutionOutput,
  decision: unknown,
  deps: RunDeps<string>,
  answerer = "tester",
): Promise<AgentExecutionOutput> {
  const [pending] = paused.pending;
  if (pending !== undefined) {
    const answer = { decision, answerer };
    await deps.pause?.pauses.resolveByTenantIdAndPauseId(
      paused.tenantId,
      pending.pauseId,
      answer,
      (deps.clock ?? systemClock).now(),
    );
  }
  const none = { values: {}, pauseIds: [], taken: [], decisions: [], answerers: [] };
  return resumeAgent(paused, (await treeResumeNow(deps, paused)) ?? none, deps);
}
