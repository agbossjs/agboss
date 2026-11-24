import type { AgentsConfigOf, ChatDefaults, ModelSettings, RouterModel } from "../config/types.js";
import type { ModelGateway } from "../llm/gateway.js";
import { createRouter, type RouterEngine } from "../routers/index.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";

import { ModelKind } from "../models/model-kind.js";
import { createLaunchDecider, type LaunchDecider } from "../flow/runtime/launch/launch-decider.js";
import { createArbiterModels, type ArbiterModels } from "../flow/runtime/launch/arbiter-call.js";
import { arbiterOf, hasArbiterModel } from "../flow/decorators/arbiter.js";
import type { ArbiterClass } from "../flow/ast.js";
import type { ModelArbiterUse } from "../flow/runtime/launch/runtime-launch.js";
import type { Class } from "../components/injection.js";
import type { AssembledGuardrails } from "../guardrails/assembly.js";
import { guardrailRuntimeOf, type GuardrailRuntime } from "../guardrails/runtime.js";

export interface FlowRouterFactoryDeps {
  readonly gateway: ModelGateway;
  readonly chatDefaults: ChatDefaults;
  /** Settings (price) of a chat model used as a router, by model id. */
  readonly chatModelSettings: (model: string) => ModelSettings;
}

/** A router's model by its id: a decision model (`kind: "jev"`), or a chat model with the settings the registry knows. */
export function routerModelOf(
  model: string,
  deps: FlowRouterFactoryDeps,
  modelProvider?: string,
  unpriced?: true,
): RouterModel {
  // the driver of the provider the cascade resolved says what the model is (#1313); no name does
  const kind = deps.gateway.kindOf?.(modelProvider) ?? ModelKind.Chat;
  const named = modelProvider === undefined ? {} : { modelProvider };
  const account = unpriced === undefined ? named : { ...named, unpriced };
  return kind === ModelKind.Decisions
    ? { kind: "jev", model, ...named }
    : { ...deps.chatModelSettings(model), kind: "llm", model, ...account };
}

/** A loaded router's model: its provider resolved through the cascade says what it is (#1313). */
const routerOf = (router: LoadedRouter, deps: FlowRouterFactoryDeps): RouterModel =>
  routerModelOf(router.model, deps, router.modelProvider, router.unpriced);

/** `FlowRuntime.routerFor` through the existing routers (one route → no call). */
export function flowRouterFactory(
  deps: FlowRouterFactoryDeps,
): (router: LoadedRouter) => RouterEngine {
  return (router) =>
    createRouter(router.name, routerOf(router, deps), deps.chatDefaults, deps.gateway);
}

/** A router's launch decisions (#273 S23) on its own model. */
export function flowLaunchDeciderFactory(
  deps: FlowRouterFactoryDeps,
): (router: LoadedRouter) => LaunchDecider {
  return (router) =>
    createLaunchDecider(router.name, routerOf(router, deps), {
      gateway: deps.gateway,
      chatDefaults: deps.chatDefaults,
    });
}

/**
 * A model arbiter's model (#279): its own `model`, a decision model or a chat model — a declarative
 * arbiter's, or the one a code arbiter injects as `ArbiterModel` (#1283); none for a code arbiter
 * without one.
 */
export function flowArbiterModelFactory(
  deps: FlowRouterFactoryDeps,
  uses: readonly ModelArbiterUse[] = [],
): (arbiter: ArbiterClass) => ArbiterModels | undefined {
  const made = new Map<ArbiterClass, ArbiterModels>();
  return (arbiter) => {
    const options = arbiterOf(arbiter)?.options;
    if (options === undefined || !hasArbiterModel(options)) return undefined;
    const found = made.get(arbiter);
    if (found !== undefined) return found;
    // the model the cascade resolved (its provider, #1313); a unit's arbiter its declared one
    const use = uses.find((candidate) => candidate.name === options.name);
    const resolved = use ?? { model: options.model ?? "", prompt: "" };
    const model = createArbiterModels(
      options.name,
      routerModelOf(resolved.model, deps, use?.modelProvider, use?.unpriced),
      { gateway: deps.gateway, chatDefaults: deps.chatDefaults },
      resolved.prompt,
    );
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
    modelOf: (model, modelProvider, unpriced) =>
      routerModelOf(model, deps, modelProvider, unpriced),
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
    ...Object.values(config.memories ?? {}).flatMap((compaction) =>
      compaction.model === undefined ? [] : [compaction.model],
    ),
  ];
  return (model) => {
    const price = known.find((candidate) => candidate.model === model)?.price;
    return price === undefined ? { model } : { model, price };
  };
}
