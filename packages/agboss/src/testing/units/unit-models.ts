import type { ResolvedModelSettings } from "../../config/types.js";
import { DEFAULT_MAX_TOKENS } from "../../config/types.js";
import type { FlowRouterFactoryDeps } from "../../graph/router-model.js";
import type { Class } from "../../components/injection.js";
import type { ModelGateway } from "../../llm/gateway.js";
import { isModelProviderClass } from "../../models/model-provider.decorator.js";
import { providerKindsOf } from "../../models/resolution.js";
import { DECISION_MODELS } from "../../models/decision-models.js";

/** The model a unit runner decides on when a component names none (a guardrail without `model`). */
export const UNIT_DECISION_MODEL: string = DECISION_MODELS[0] ?? "typesafe/jev-1.13";

/**
 * A chat model of a unit runner: no price — its scripted provider reports each call's cost, the
 * turn's `{ cost: usd(…) }` or nothing.
 */
export const unitChatSettings = (model: string): ResolvedModelSettings => ({
  model,
  temperature: 0,
  maxTokens: DEFAULT_MAX_TOKENS,
});

/**
 * What a unit runner's routers and arbiters decide on: the scripted gateway, unpriced chat models.
 * `providers` are the model providers the component under test names: their drivers say whether
 * a model decides or chats, as in an application (no model name does).
 */
export const unitRouterDeps = (
  gateway: ModelGateway,
  providers: readonly (Class | undefined)[] = [],
): FlowRouterFactoryDeps => {
  const kinds = providerKindsOf(
    providers.filter((cls) => cls !== undefined && isModelProviderClass(cls)),
  );
  return {
    gateway: Object.assign(Object.create(gateway) as ModelGateway, {
      kindOf: (name: string | undefined) => (name === undefined ? undefined : kinds.get(name)),
    }),
    chatDefaults: { temperature: 0 },
    chatModelSettings: (model) => ({ model }),
  };
};
