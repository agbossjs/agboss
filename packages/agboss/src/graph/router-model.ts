import type { AgentsConfigOf, ChatDefaults, ModelSettings, RouterModel } from "../config/types.js";
import type { ModelGateway } from "../llm/gateway.js";
import { createRouter, type RouterEngine } from "../routers/index.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";

import { isDecisionModel } from "../models/decision-models.js";
import { createLaunchDecider, type LaunchDecider } from "../flow/runtime/launch/launch-decider.js";
import { createArbiterModel, type ArbiterModel } from "../flow/runtime/launch/arbiter-model.js";
import { arbiterOf, isCodeArbiter } from "../flow/decorators/arbiter.js";
import type { ArbiterClass } from "../flow/ast.js";
import type { Class } from "../components/injection.js";
import type { AssembledGuardrails } from "../guardrails/assembly.js";
import { guardrailRuntimeOf, type GuardrailRuntime } from "../guardrails/runtime.js";

export { isDecisionModel };

export interface FlowRouterFactoryDeps {
  readonly gateway: ModelGateway;
  readonly chatDefaults: ChatDefaults;
  /** Settings (price) of a chat model used as a router, by model id. */
  readonly chatModelSettings: (model: string) => ModelSettings;
}

/** A router's model by its id: a decision model (`kind: "jev"`), or a chat model with the settings the registry knows. */
export function routerModelOf(model: string, deps: FlowRouterFactoryDeps): RouterModel {
  return isDecisionModel(model)
    ? { kind: "jev", model }
    : { ...deps.chatModelSettings(model), kind: "llm", model };
}

/** `FlowRuntime.routerFor` through the existing routers (one route → no call). */
export function flowRouterFactory(
  deps: FlowRouterFactoryDeps,
): (router: LoadedRouter) => RouterEngine {
  return (router) =>
    createRouter(router.name, routerModelOf(router.model, deps), deps.chatDefaults, deps.gateway);
}

/** A router's launch decisions (#273 S23) on its own model. */
export function flowLaunchDeciderFactory(
  deps: FlowRouterFactoryDeps,
): (router: LoadedRouter) => LaunchDecider {
  return (router) =>
    createLaunchDecider(router.name, routerModelOf(router.model, deps), {
      gateway: deps.gateway,
      chatDefaults: deps.chatDefaults,
    });
}

/** A model arbiter's model (#279): its own `model`, a decision model or a chat model; none for code. */
export function flowArbiterModelFactory(
  deps: FlowRouterFactoryDeps,
): (arbiter: ArbiterClass) => ArbiterModel | undefined {
  const made = new Map<ArbiterClass, ArbiterModel>();
  return (arbiter) => {
    const options = arbiterOf(arbiter)?.options;
    if (options === undefined || isCodeArbiter(options)) return undefined;
    const found = made.get(arbiter);
    if (found !== undefined) return found;
    const model = createArbiterModel(options.name, routerModelOf(options.model, deps), {
      gateway: deps.gateway,
      chatDefaults: deps.chatDefaults,
    });
    made.set(arbiter, model);
    return model;
  };
}

/** A workflow's guardrails (#120), each on its own model; `resolve` gives a class's instance. */
export function flowGuardrailRuntime(
  assembled: AssembledGuardrails | undefined,
  resolve: (cls: Class) => unknown,
  deps: FlowRouterFactoryDeps,
): GuardrailRuntime {
  return guardrailRuntimeOf(assembled, {
    resolve,
    modelOf: (model) => routerModelOf(model, deps),
    deciderDeps: { gateway: deps.gateway, chatDefaults: deps.chatDefaults },
  });
}

/**
 * A router on a chat model: priced like the agent (or compaction) that uses the same model when one
 * has a price; otherwise its provider reports the cost (or prices it from its table).
 */
export function chatModelSettingsOf(
  config: AgentsConfigOf<string>,
): (model: string) => ModelSettings {
  const known: readonly ModelSettings[] = [
    ...Object.values(config.agents),
    ...Object.values(config.compactions ?? {}).flatMap((compaction) =>
      compaction.model === undefined ? [] : [compaction.model],
    ),
  ];
  return (model) => {
    const price = known.find((candidate) => candidate.model === model)?.price;
    return price === undefined ? { model } : { model, price };
  };
}
