import { ModelKind } from "./model-kind.js";
import type { ModelUse } from "./uses.js";

/** The kind each provider of a workflow serves, by `name`: what its driver speaks (#1313). */
export type ProviderKinds = ReadonlyMap<string, ModelKind>;

/**
 * A model's use: what its provider's driver speaks when its cascade names one, else chat (a custom
 * provider class chats through `complete`). No model name tells a decision model.
 */
export const purposeOf = (modelProvider?: string, kinds?: ProviderKinds): ModelKind =>
  (modelProvider === undefined ? undefined : kinds?.get(modelProvider)) ?? ModelKind.Chat;

/** A named provider on a use, when there is one. */
export const providerOf = (modelProvider: string | undefined): Pick<ModelUse, "modelProvider"> =>
  modelProvider === undefined ? {} : { modelProvider };
