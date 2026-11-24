import type { resolveSettings } from "../llm/registry.js";
import { ModelKind } from "./model-kind.js";
import type { ModelUse, ModelUseKey } from "./uses.js";
import { providerOf, purposeOf, type ProviderKinds } from "./use-purpose.js";

/** A reply interpreter (#267 PR 3): its model, or none for a code one. */
export interface ModelNamingInterpreter {
  readonly name: string;
  readonly model: string | undefined;
  /** The provider's `name` its cascade resolved (#1313). */
  readonly modelProvider?: string | undefined;
}

/** The reply interpreters' models: a decision model reads an approval's yes / no (#267 S124 a). */
export const interpreterUsesOf = (
  interpreters: readonly ModelNamingInterpreter[],
  chat: (key: ModelUseKey, settings: Parameters<typeof resolveSettings>[0]) => ModelUse,
  kinds: ProviderKinds | undefined,
): readonly ModelUse[] =>
  interpreters.flatMap(({ name, model, modelProvider }): readonly ModelUse[] => {
    if (model === undefined) return [];
    const key: ModelUseKey = `channelInterpreters.${name}`;
    return purposeOf(model, modelProvider, kinds) === ModelKind.Decisions
      ? [{ key, model, purpose: ModelKind.Decisions, ...providerOf(modelProvider) }]
      : [chat(key, { model, ...providerOf(modelProvider) })];
  });
