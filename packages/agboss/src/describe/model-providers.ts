import type { AssembledApplication } from "../application/assemble.js";
import { ImplementationReason } from "../application/implementations.js";
import {
  isModelProviderClass,
  isTransportClass,
  modelProviderOf,
} from "../models/model-provider.decorator.js";

/** One model provider of the application and why it is used. */
export interface DescribedModelProvider {
  readonly name: string;
  readonly className: string;
  readonly reason: ImplementationReason;
  /** It makes its own calls through `complete(request)` (#385), not over HTTP. */
  readonly isTransport: boolean;
  /** Named by a `modelProvider` (its application's, a workflow's, a component's), not listed in `providers` (#1313). */
  readonly isNamed: boolean;
}

/**
 * The application's model providers: the listed ones, and those a `modelProvider` names (the application's,
 * a workflow's, a component's) though none lists them (#1313).
 */
export function modelProvidersOfApplication(
  assembled: AssembledApplication,
): readonly DescribedModelProvider[] {
  const listed = assembled.providers.filter(isModelProviderClass);
  const named = assembled.workflows.flatMap((workflow) => workflow.modelProviders);
  const all = [...new Set([...listed, ...named])];
  return all.map((provider) => {
    const options = modelProviderOf(provider);
    const isListed = listed.includes(provider);
    return {
      name: options.name,
      className: provider.name,
      reason: isListed ? ImplementationReason.Listed : ImplementationReason.Default,
      isTransport: isTransportClass(provider),
      isNamed: !isListed,
    };
  });
}
