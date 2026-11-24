import {
  isTransportClass,
  modelProviderOf,
  type ModelProviderType,
} from "../models/model-provider.decorator.js";

/**
 * The transport providers (#385) of a workflow's application in its `configHash`: by name, class
 * and what they serve — only where there is one, so every other workflow keeps its hash.
 */
export function transportSnapshot(providers: readonly ModelProviderType[] | undefined): object {
  const transports = (providers ?? []).filter(isTransportClass).map((cls) => {
    const { name, serves } = modelProviderOf(cls);
    return { name, className: cls.name, serves: serves.map(String) };
  });
  return transports.length === 0 ? {} : { transports };
}
