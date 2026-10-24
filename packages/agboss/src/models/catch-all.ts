import { DecisionsModelProvider } from "./jev.provider.js";
import type { ModelProviderType } from "./model-provider.decorator.js";
import { OpenRouterModelProvider } from "./openrouter-model.provider.js";

/**
 * The built-in catch-all providers (#454): `OpenRouterModelProvider` (every chat model but the
 * decision models) and `DecisionsModelProvider` (every decision model). Where the application lists
 * one — by default, or by name next to its own —, it serves its models **except** those another
 * listed provider claims by `serves`: a project's provider for its own prefix needs no narrowed
 * copy of it. Only these classes yield; a subclass with its own `@ModelProvider` claims what its
 * `serves` says, like any other provider.
 */
const CATCH_ALL_PROVIDERS: ReadonlySet<ModelProviderType> = new Set<ModelProviderType>([
  OpenRouterModelProvider,
  DecisionsModelProvider,
]);

/** Whether the class is a built-in catch-all, which yields to an explicit claim. */
export const isCatchAllProvider = (type: ModelProviderType): boolean =>
  CATCH_ALL_PROVIDERS.has(type);
