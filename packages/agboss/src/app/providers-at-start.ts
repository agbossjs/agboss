import { registeredIn } from "../llm/provider-chat-of.js";
import {
  isModelProviderClass,
  type ModelProviderType,
} from "../models/model-provider.decorator.js";
import type { ModelProviderDirectory, RegisteredModelProvider } from "../models/resolve.js";
import type { ModelUse } from "../models/uses.js";

/**
 * The providers connected at start (#716): each one a model use resolves to, and its breaker's
 * fallback, listed in the directory or not (an unlisted one is registered as at run time) — the
 * directory's providers first, in its order. The others connect on first use.
 */
export function providersAtStart(
  uses: readonly ModelUse[],
  directory: ModelProviderDirectory,
): readonly RegisteredModelProvider[] {
  const needed = new Set<ModelProviderType>();
  const fallbacks: ModelProviderType[] = [];
  for (const use of uses) {
    const resolution = directory.resolve(use);
    if (resolution.kind !== "resolved") continue;
    needed.add(resolution.provider.type);
    const fallback = resolution.provider.options.circuitBreakerPolicy.fallback;
    if (isModelProviderClass(fallback)) fallbacks.push(fallback);
  }
  const registeredFor = registeredIn(directory);
  const wanted = [...needed, ...fallbacks];
  const listed = directory.providers.filter((provider) => wanted.includes(provider.type));
  const unlisted = [...new Set(fallbacks)].filter(
    (cls) => !directory.providers.some((provider) => provider.type === cls),
  );
  return [...listed, ...unlisted.map(registeredFor)];
}
