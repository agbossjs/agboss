import { ConfigError } from "../core/error-families/config-errors.js";
import { ComponentOptions } from "../components/component-options.js";
import { BranchErrors } from "../flow/runtime/launch/branch-end.js";
import type { BranchScheduler } from "../flow/runtime/launch/branch-schedule.js";
import type { JudgeInstance } from "../components/judge-decorators.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { KnowledgeSource } from "../rag/types.js";
import { rerankerBindingOf } from "../llm/registry.js";
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
import type { AnyTool } from "../tools/index.js";
import type { PauseNotices, PauseSeam } from "../pause/index.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import type { PauseAnswerLog } from "../infrastructure/pause-answer-log.js";
import type { ContainerOptions } from "../components/container/container.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";
import type { ReplyReaderParts } from "../channels/reply-reader.js";
import type { Class } from "../components/injection.js";
import { decisionServiceOf } from "../components/decision-target.js";
import type { ModelPricing } from "../models/model-pricing.js";

/** The lookup's miss: only this is "no such tool" — any other `ConfigError.Component` is a real failure (#1413 M4). */
export class UnknownToolError extends ConfigError.Component {}

/** Tool lookup for the graph; an unknown name is a wiring bug. */
export const toolLookup = (tools: readonly AnyTool[]): ((name: string) => AnyTool) => {
  const byName = new Map(tools.map((tool) => [tool.name, tool] as const));
  return (name) => {
    const tool = byName.get(name);
    if (tool === undefined) throw new UnknownToolError({ message: `Unknown tool "${name}"` });
    return tool;
  };
};

/** Whether a tool lookup knows a name: an unknown one is `false`, any other failure is thrown. */
export function knows(lookup: (name: string) => AnyTool, name: string): boolean {
  try {
    lookup(name);
    return true;
  } catch (error) {
    if (error instanceof UnknownToolError) return false;
    throw error;
  }
}

/** Eval / replay: a Jev judge, its spend counted in the application's budgets. */
export const evaluationFor = (
  bundle: AssembledWorkflow,
  stores: Pick<EvalDeps, "turns" | "budgets">,
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
  pricing: ModelPricing,
): WorkflowServices => ({
  router: (name) => defaultRouterOf(name, bundle.config, gateway),
  decide: decisionServiceOf(bundle, gateway),
  contexts,
  container,
  rerankModel: rerankerBindingOf(bundle.config, gateway, pricing),
  rerankInstructions: (reranker) =>
    bundle.rerankers?.find((found) => found.name === reranker)?.prompt ?? "",
});

/** Context-mode knowledge bases per agent, when the workflow has any. */
export function knowledgeFor(
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): { readonly knowledge?: (agent: string) => readonly KnowledgeSource[] } {
  const byAgent = bundle.knowledge?.(services);
  return byAgent === undefined ? {} : { knowledge: (agent) => byAgent.get(agent) ?? [] };
}

/** The agents' judges by name, created by the workflow's container. */
export const judgesFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
): { readonly judges?: ReadonlyMap<string, JudgeInstance> } => {
  const judges = bundle.judges?.(services);
  return judges === undefined ? {} : { judges };
};

/** The pause seam (#267 S35): the app's checkpointer, its record of every pause and its notices. */
export const pauseFor = (
  checkpointer: BaseCheckpointSaver,
  pauses: PausedExecutionRepository,
  answers: PauseAnswerLog,
  notices?: PauseNotices,
): PauseSeam => ({ checkpointer, pauses, answers, ...(notices === undefined ? {} : { notices }) });

/**
 * The workflow's guardrails (#120): each on its own model or `defaults.guardrail.model` (resolved at
 * assembly — `[model.missing-provider]` otherwise), its refusal class from the workflow's container.
 */
export const guardrailsFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
  pricing: ModelPricing,
): GuardrailRuntime =>
  flowGuardrailRuntime(bundle.guardrails, bundle.resolve(services), {
    gateway,
    chatDefaults: config.defaults.models,
    chatModelSettings: chatModelSettingsOf(pricing),
  });

/** The workflow's guardrails (#120) and its tool interceptors (#384), their classes from its container. */
export const policiesFor = (
  bundle: AssembledWorkflow,
  services: WorkflowServices,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
  pricing: ModelPricing,
): {
  readonly guardrails: GuardrailRuntime;
  readonly toolInterceptors: ToolInterceptorRuntime;
} => ({
  guardrails: guardrailsFor(bundle, services, config, gateway, pricing),
  toolInterceptors: toolInterceptorRuntimeOf(bundle.toolInterceptors, bundle.resolve(services)),
});

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
  const message = `${name} decides on the workflow's default router, but @Workflow({ defaults: { router: { model } } }) is not set`;
  return { name, route: () => Promise.reject(new ConfigError.NoDefaultRouter({ message })) };
}

/** The workflow's graph, steps limit and routers; each router decides on its own model. */
export const flowFor = (
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
  pricing: ModelPricing,
  branchScheduler?: BranchScheduler,
): Pick<
  AgentExecutionDeps<string>,
  | "graph"
  | "maxSteps"
  | "executionLimitsOf"
  | "routers"
  | "routerFor"
  | "launchDecisionFor"
  | "arbiterModelFor"
  | "arbiters"
  | "branchErrors"
  | "branchScheduler"
> => {
  const routerDeps = {
    gateway,
    chatDefaults: config.defaults.models,
    chatModelSettings: chatModelSettingsOf(pricing),
  };
  return {
    graph: bundle.graph,
    maxSteps: bundle.maxSteps,
    executionLimitsOf: (bundle.componentOptions ?? ComponentOptions.none).executionLimitsOf,
    routers: bundle.routers,
    routerFor: flowRouterFactory(routerDeps),
    launchDecisionFor: flowLaunchDeciderFactory(routerDeps),
    arbiterModelFor: flowArbiterModelFactory(routerDeps, bundle.arbiters),
    ...(bundle.arbiters === undefined ? {} : { arbiters: bundle.arbiters }),
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
  pricing: ModelPricing,
  container: { readonly get: <T>(token: Class<T>) => T },
): ReplyReaderParts => ({
  interpreters: bundle.replyInterpreters ?? [],
  gateway,
  chatDefaults: config.defaults.models,
  chatModelSettings: chatModelSettingsOf(pricing),
  instanceOf: (interpreter) => container.get(interpreter),
});
