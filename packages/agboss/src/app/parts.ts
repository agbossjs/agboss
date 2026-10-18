import type { BaseMemoryStrategy } from "../memory/types.js";
import type { JudgeHandler } from "../components/judge-decorators.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { AssembledWorkflow, WorkflowServices } from "../workflow.js";
import type { KnowledgeSource } from "../rag/types.js";
import type { AgentsConfigOf } from "../config/types.js";
import { chatModelSettingsOf, flowRouterFactory } from "../graph/router-model.js";
import type { EvalDeps } from "../eval/eval.js";
import type { RunDeps } from "../run/types.js";
import type { ModelGateway } from "../llm/gateway.js";
import { buildGuards, type GuardSet } from "../guards/index.js";
import { guardPrompts } from "../prompts/guards.js";
import { createRouter, type RouterEngine } from "../routers/index.js";
import { ComponentError } from "../components/metadata.js";
import type { AnyTool } from "../tools/index.js";
import type { PauseSeam } from "../pause/index.js";
import type { ContainerOptions } from "../components/container/container.js";
import type { Environment } from "../environments/define.js";

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

/** Eval / replay: a Jev judge, spend on `<workflow>:eval` — its own day, capped like the workflow's. */
export const evaluationFor = (
  bundle: AssembledWorkflow,
  stores: Pick<EvalDeps, "terns" | "ledger">,
  gateway: ModelGateway,
): EvalDeps => ({
  ...stores,
  judge: defaultRouterOf("judge", bundle.config, gateway),
  account: {
    key: `${bundle.config.name}:eval`,
    dailyCap: bundle.limits.perDay?.cost ?? Number.POSITIVE_INFINITY,
  },
});

/** Core services for the workflow's components; one object, so tools and knowledge share instances. */
export const servicesFor = (
  bundle: AssembledWorkflow,
  gateway: ModelGateway,
  environment: Environment | undefined,
  container: ContainerOptions,
): WorkflowServices => ({
  router: (name) => defaultRouterOf(name, bundle.config, gateway),
  ...(environment === undefined ? {} : { environment }),
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
): { readonly judges?: ReadonlyMap<string, JudgeHandler> } => {
  const judges = bundle.judges?.(services);
  return judges === undefined ? {} : { judges };
};

/** The pause seam, when the workflow has tools that wait for an approval; on the app's checkpointer. */
export const pauseFor = (
  bundle: AssembledWorkflow,
  checkpointer: BaseCheckpointSaver,
): PauseSeam | undefined => ({
  checkpointer,
});

/** Guards from config + their texts; each guard is a router (Jev unless it sets a model). */
export const guardsFor = (config: AgentsConfigOf<string>, gateway: ModelGateway): GuardSet =>
  buildGuards(config.guards, guardPrompts, (name, model) =>
    model === undefined
      ? defaultRouterOf(`guard:${name}`, config, gateway)
      : createRouter(`guard:${name}`, model, config.defaults.models, gateway),
  );

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

/** The workflow's graph, limits and routers; each router decides on its own model. */
export const flowFor = (
  bundle: AssembledWorkflow,
  config: AgentsConfigOf<string>,
  gateway: ModelGateway,
): Pick<RunDeps<string>, "graph" | "limits" | "maxSteps" | "routers" | "routerFor"> => ({
  graph: bundle.graph,
  limits: bundle.limits,
  maxSteps: bundle.maxSteps,
  routers: bundle.routers,
  routerFor: flowRouterFactory({
    gateway,
    chatDefaults: config.defaults.models,
    chatModelSettings: chatModelSettingsOf(config),
  }),
});
