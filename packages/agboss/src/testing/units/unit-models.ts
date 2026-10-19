import type { ResolvedModelSettings } from "../../config/types.js";
import { DEFAULT_MAX_TOKENS } from "../../config/types.js";
import type { FlowRouterFactoryDeps } from "../../graph/router-model.js";
import type { ModelGateway } from "../../llm/gateway.js";

/**
 * A chat model of a unit runner: no price — its scripted provider reports each call's cost, the
 * turn's `{ cost: usd(…) }` or nothing.
 */
export const unitChatSettings = (model: string): ResolvedModelSettings => ({
  model,
  temperature: 0,
  maxTokens: DEFAULT_MAX_TOKENS,
});

/** What a unit runner's routers and arbiters decide on: the scripted gateway, unpriced chat models. */
export const unitRouterDeps = (gateway: ModelGateway): FlowRouterFactoryDeps => ({
  gateway,
  chatDefaults: { temperature: 0 },
  chatModelSettings: (model) => ({ model }),
});
