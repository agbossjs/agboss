import { isDecisionModel } from "./decision-models.js";
import { ModelKind } from "./model-kind.js";
import type { ModelUse } from "./uses.js";

/** The kind each provider of a workflow serves, by `name`: what its driver speaks (#1313). */
export type ProviderKinds = ReadonlyMap<string, ModelKind>;

/**
 * A model's use: what its provider's driver speaks when its cascade names one, else — the older
 * providers — a decision model decides and anything else chats.
 */
export const purposeOf = (
  model: string,
  modelProvider?: string,
  kinds?: ProviderKinds,
): ModelKind =>
  (modelProvider === undefined ? undefined : kinds?.get(modelProvider)) ??
  (isDecisionModel(model) ? ModelKind.Decisions : ModelKind.Chat);

/** A named provider on a use, when there is one. */
export const providerOf = (modelProvider: string | undefined): Pick<ModelUse, "modelProvider"> =>
  modelProvider === undefined ? {} : { modelProvider };
