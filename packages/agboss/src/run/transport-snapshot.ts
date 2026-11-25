import {
  isTransportClass,
  modelProviderOf,
  type ModelProviderType,
} from "../models/model-provider.decorator.js";

/**
 * The transport providers (#385) of a workflow's application in its `configHash`: by name, class
 * and the models they name — only where there is one, so every other workflow keeps its hash.
 */
export function transportSnapshot(providers: readonly ModelProviderType[] | undefined): object {
  const transports = (providers ?? []).filter(isTransportClass).map((cls) => {
    const { name, model, models } = modelProviderOf(cls);
    return { name, className: cls.name, model, models };
  });
  return transports.length === 0 ? {} : { transports };
}
