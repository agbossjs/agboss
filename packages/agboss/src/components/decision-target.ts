import { ConfigError } from "../core/error-families/config-errors.js";
import type { AgentsConfigOf } from "../config/types.js";
import { OMITTED_MODEL, type ModelCascade } from "../models/model-cascade.js";
import { modelResolverOf, type ModelUseLike } from "../models/model-resolver.js";
import type { DecisionTargetOf } from "./decision-model.js";
import type { DecisionService } from "./decision-model.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { ModelGateway } from "../llm/gateway.js";
import { ModelKind } from "../models/model-kind.js";
import { ModelKindError } from "../llm/decision-errors.js";

/** Where a `DecisionModel` call goes (#1313): its own `modelProvider` / `model`, else the workflow's cascade; with no provider anywhere, `defaults.router.model` as before drivers (until F2). */
export const decisionTargetOfWorkflow = (
  workflow: string,
  cascade: ModelCascade,
  config: AgentsConfigOf<string>,
): DecisionTargetOf => {
  return (options) => {
    const resolver = modelResolverOf(workflow, cascade);
    const isOmitted = options.model === undefined;
    const used = resolver.use<ModelUseLike>(
      { model: options.model ?? OMITTED_MODEL },
      "decisions",
      {
        ...(options.modelProvider === undefined ? {} : { provider: options.modelProvider }),
        isOmitted,
      },
    );
    resolver.check();
    if (used.modelProvider !== undefined)
      return { model: used.model, modelProvider: used.modelProvider };
    const model = options.model ?? config.defaults.router?.model;
    if (model === undefined)
      throw new ConfigError.Component({
        message: `DecisionModel.decide names no model and no modelProvider is set — pass { model } or { modelProvider }, or set modelProvider on the @Workflow or the @Application`,
      });
    return { model };
  };
};

/**
 * The model behind `DecisionModel` (#1313): the call's target through the workflow's cascade (its own
 * options first), the gateway's decision on it. A provider that speaks chat cannot decide.
 */
export const decisionServiceOf =
  (bundle: Pick<AssembledWorkflow, "decisionTargetOf">, gateway: ModelGateway): DecisionService =>
  async ({ caller, options, request }) => {
    const target = bundle.decisionTargetOf?.(options) ?? { model: options.model };
    const { model, modelProvider } = target as { model?: string; modelProvider?: string };
    if (model === undefined)
      throw new ConfigError.Component({
        message: `${caller}: DecisionModel.decide names no model`,
      });
    if (gateway.decide === undefined)
      throw new TypeError(`${caller}: the model gateway has no decisions (${model})`);
    if (gateway.kindOf?.(modelProvider) === ModelKind.Chat)
      throw new ModelKindError({ model, kind: ModelKind.Chat, call: "decide" });
    return gateway.decide({ caller, model, modelProvider, request });
  };
