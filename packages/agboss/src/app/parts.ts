import { BranchErrors } from "../flow/runtime/launch/branch-end.js";
import type { BranchScheduler } from "../flow/runtime/launch/branch-schedule.js";
import type { BaseMemoryStrategy } from "../memory/types.js";
import type { JudgeInstance } from "../components/judge-decorators.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { KnowledgeSource } from "../rag/types.js";
import type { AgentsConfigOf } from "../config/types.js";
import {
  chatModelSettingsOf,
  flowArbiterModelFactory,
  flowGuardrailRuntime,
  flowLaunchDeciderFactory,
  flowRouterFactory,
} from "../graph/router-model.js";
import type { GuardrailRuntime } from "../guardrails/runtime.js";
import {
  toolInterceptorRuntimeOf,
  type ToolInterceptorRuntime,
} from "../tool-interceptors/runtime.js";
import type { EvalDeps } from "../eval/eval.js";
import type { AgentExecutionDeps } from "../run/types.js";
import type { ModelGateway } from "../llm/gateway.js";
import { createRouter, type RouterEngine } from "../routers/index.js";
import { ComponentError } from "../components/metadata.js";
import type { AnyTool } from "../tools/index.js";
import type { PauseSeam, PauseWithdrawn } from "../pause/index.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseAnswerLog } from "../infrastructure/pause-record.js";
import type { ContainerOptions } from "../components/container/container.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { ReplyReaderParts } from "../channels/reply-reader.js";
import type { Class } from "../components/injection.js";
import type { AppDeps } from "./app-deps.js";

export class UnknownToolError extends Error {
  override name = "UnknownToolError";
}

/** Tool lookup for the graph; an unknown name is a wiring bug. */
export const toolLookup = (tools: readonly AnyTool[]): ((name: string) => AnyTool) => {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return (name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new UnknownToolError(`Unknown tool "${name}"`);
    return tool;
  };
};

/** Eval / replay: a Jev judge, its spend counted in the application's budgets. */
export const evaluationFor = (
  bundle: AssembledWorkflow,
  stores: Pick<EvalDeps, "terns" | "budgets">,
  gateway: ModelGateway,
): EvalDeps => ({
  ...stores,
  judge: defaultRouterOf("judge", bundle.config, gateway),
  gateway,
});

/** Core services for the workflow's components; one object, so tools and knowledge share instances. */
export const servicesFor = (
  bundle: AssembledWorkflow,
  gateway: ModelGateway,
  contexts: RuntimeContexts,
  container: ContainerOptions,
): WorkflowServices => ({
  router: (name) => defaultRouterOf(name, bundle.config, gateway),
  contexts,
  container,
});

/** Context-mode knowledge bases per agent, when the workflow has any. */
export function knowledgeFor(
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): { readonly knowledge?: (agent: string) => readonly KnowledgeSource[] } {
  const byAgent = bundle.knowledge?.(services);
  return byAgent === undefined ? {} : { knowledge: (agent) => byAgent.get(agent) ?? [] };
}

/** The agents' own memory strategies (`@Agent({ memoryStrategy })`), from the container. */
export const memoryFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): { readonly memory?: ReadonlyMap<string, BaseMemoryStrategy> } => {
  const memory = bundle.memoryStrategies?.(services);
  return memory === undefined ? {} : { memory };
};

/** The agents' judges by name, created by the workflow's container. */
export const judgesFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): { readonly judges?: ReadonlyMap<string, JudgeInstance> } => {
  const judges = bundle.judges?.(services);
  return judges === undefined ? {} : { judges };
};

/** The pause seam (#267 S35): the app's checkpointer and its record of every pause. */
export const pauseFor = (
  checkpointer: BaseCheckpointSaver,
  pauses: PausedExecutionRepository,
  answers: PauseAnswerLog,
): PauseSeam => ({ checkpointer, pauses, answers });

/** Telling channels about withdrawn pauses, loaded with the first one (#205: a lean root import). */
function lazyPauseWithdrawals(depsOf: () => AppDeps): PauseWithdrawn {
  let loaded: Promise<PauseWithdrawn> | undefined;
  return async (withdrawn) => {
    loaded ??= import("./pause-withdrawals.js").then((module) =>
      module.pauseWithdrawalsFor(depsOf()),
    );
    const tell = await loaded;
    await tell(withdrawn);
  };
}

/** A workflow's run deps whose pause seam tells channels, and the hook it tells them with. */
export interface PauseWithdrawals {
  readonly deps: AppDeps;
  readonly withdrawn: PauseWithdrawn;
}

/**
 * The app's run deps with a pause seam that tells a channel its pause was withdrawn (#337): the
 * channels, frames and tools it needs are these deps', made once they are.
 */
export function withWithdrawals(made: AppDeps): PauseWithdrawals {
  const withdrawn = lazyPauseWithdrawals(() => deps);
  const deps: AppDeps =
    made.pause === undefined ? made : { ...made, pause: { ...made.pause, withdrawn } };
  return { deps, withdrawn };
}

/**
 * The workflow's guardrails (#120): each on its own model or `defaults.guardrail.model` (resolved at
 * assembly — `[guardrail.no-model]` otherwise), its refusal class from the workflow's container.
 */
export const guardrailsFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
): GuardrailRuntime =>
  flowGuardrailRuntime(bundle.guardrails, bundle.resolve(services), {
    gateway,
    chatDefaults: config.defaults.models,
    chatModelSettings: chatModelSettingsOf(config),
  });

/** The workflow's guardrails (#120) and its tool interceptors (#384), their classes from its container. */
export const policiesFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
): {
  readonly guardrails: GuardrailRuntime;
  readonly toolInterceptors: ToolInterceptorRuntime;
} => ({
  guardrails: guardrailsFor(bundle, services, config, gateway),
  toolInterceptors: toolInterceptorRuntimeOf(bundle.toolInterceptors, bundle.resolve(services)),
});

/** A model is needed for it, and `defaults.router.model` is not set. */
export class NoDefaultRouterError extends ComponentError {
  override name = "NoDefaultRouterError";
}

/**
 * A router on the workflow's `defaults.router.model` (guards, `ROUTER_FACTORY`, eval). Without a
 * default it fails when asked to decide, naming the fix — not at start, when nothing uses it.
 */
export function defaultRouterOf(
  name: string,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
): RouterEngine {
  const model = config.defaults.router;
  if (model !== undefined) return createRouter(name, model, config.defaults.models, gateway);
  return {
    name,
    route: () =>
      Promise.reject(
        new NoDefaultRouterError(
          `${name} decides on the workflow's default router, but @Workflow({ defaults: { router: { model } } }) is not set`,
        ),
      ),
  };
}

/** The workflow's graph, steps limit and routers; each router decides on its own model. */
export const flowFor = (
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
  branchScheduler?: BranchScheduler,
): Pick<
  AgentExecutionDeps<string>,
  | "graph"
  | "maxSteps"
  | "routers"
  | "routerFor"
  | "launchDecisionFor"
  | "arbiterModelFor"
  | "branchErrors"
  | "branchScheduler"
> => {
  const routerDeps = {
    gateway,
    chatDefaults: config.defaults.models,
    chatModelSettings: chatModelSettingsOf(config),
  };
  return {
    graph: bundle.graph,
    maxSteps: bundle.maxSteps,
    routers: bundle.routers,
    routerFor: flowRouterFactory(routerDeps),
    launchDecisionFor: flowLaunchDeciderFactory(routerDeps),
    arbiterModelFor: flowArbiterModelFactory(routerDeps),
    // a launch's branch errors, kept across passes (a withdrawal's join rethrows the original)
    branchErrors: new BranchErrors(),
    // a test's schedule of the branches (#262 S33); none in production
    ...(branchScheduler === undefined ? {} : { branchScheduler }),
  };
};

/** The reply interpreters of the workflow's tree (#267 PR 3): code ones from its container. */
export const repliesFor = (
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
  container: { readonly get: <T>(token: Class<T>) => T },
): ReplyReaderParts => ({
  interpreters: bundle.replyInterpreters ?? [],
  gateway,
  chatDefaults: config.defaults.models,
  chatModelSettings: chatModelSettingsOf(config),
  instanceOf: (interpreter) => container.get(interpreter),
});
