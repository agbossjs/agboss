import type { ChatDefaults, RouterModel } from "../config/types.js";
import type { DecisionModel, ModelGateway } from "../llm/gateway.js";
import { resolveSettings } from "../llm/registry.js";
import { decided, failed } from "./outcome.js";
import type { RouterEngine } from "./types.js";

/**
 * One option = an unconditional step, no options = nothing to routeTo: neither pays for a call.
 */
export function withTrivialOptions(router: RouterEngine): RouterEngine {
  return {
    name: router.name,
    route: (request) => {
      const [only, ...rest] = request.options;
      if (only === undefined) return Promise.resolve(failed("no options to route to"));
      if (rest.length === 0)
        return Promise.resolve(decided({ next: only.name, reason: "single option" }));
      return router.route(request);
    },
  };
}

/** A router's configured model with the chat defaults applied (LLM routers). */
function decisionModelOf(model: RouterModel, chatDefaults: ChatDefaults): DecisionModel {
  return model.kind === "jev"
    ? {
        kind: "jev",
        model: model.model,
        // the provider its cascade resolved: without it the call has no provider to go to (#1313)
        ...(model.modelProvider === undefined ? {} : { modelProvider: model.modelProvider }),
      }
    : { kind: "llm", settings: resolveSettings(model, chatDefaults) };
}

/**
 * Builds a router from its model config (use resolveRouterModel for the Jev default). Every paid
 * decision goes through the gateway; trivial option sets never reach it.
 */
export function createRouter(
  name: string,
  model: RouterModel,
  chatDefaults: ChatDefaults,
  gateway: Pick<ModelGateway, "routeTo">,
): RouterEngine {
  const decisionModel = decisionModelOf(model, chatDefaults);
  return withTrivialOptions({
    name,
    route: (request) => gateway.routeTo({ router: name, model: decisionModel, request }),
  });
}
