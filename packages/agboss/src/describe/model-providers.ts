import type { Class } from "../components/injection.js";
import type { AssembledApplication } from "../application/assemble.js";
import { ImplementationReason } from "../application/implementations.js";
import {
  isModelProviderClass,
  isTransportClass,
  modelProviderOf,
} from "../models/model-provider.decorator.js";
import { modelProvidersOf } from "../models/resolution.js";
import { DEFAULT_MODEL_PROVIDERS } from "../models/workflow-models.js";

/** One model provider of the application and why it is used. */
export interface DescribedModelProvider {
  readonly name: string;
  readonly className: string;
  readonly reason: ImplementationReason;
  /** `serves`, each pattern as written. */
  readonly serves: readonly string[];
  /** It makes its own calls through `complete(request)` (#385), not over HTTP. */
  readonly isTransport: boolean;
  /** Named by a `modelProvider` (its application's, a workflow's, a component's), not listed in `providers` (#1313). */
  readonly isNamed: boolean;
}

/**
 * The application's model providers: the listed ones, those a `modelProvider` names (the application's,
 * a workflow's, a component's) though none lists them (#1313), else the built-ins (#266).
 */
export function modelProvidersOfApplication(
  assembled: AssembledApplication,
): readonly DescribedModelProvider[] {
  const listed = assembled.providers.filter(isModelProviderClass);
  const named = assembled.workflows.flatMap((workflow) => workflow.modelProviders);
  const all = [...new Set([...listed, ...named])];
  return (all.length === 0 ? modelProvidersOf(assembled.providers) : all).map((provider) => {
    const options = modelProviderOf(provider);
    const isListed = listed.includes(provider);
    return {
      name: options.name,
      className: provider.name,
      reason: isListed ? ImplementationReason.Listed : ImplementationReason.Default,
      serves: (options.serves ?? []).map(String),
      isTransport: isTransportClass(provider),
      isNamed: !isListed && !(DEFAULT_MODEL_PROVIDERS as readonly Class[]).includes(provider),
    };
  });
}
