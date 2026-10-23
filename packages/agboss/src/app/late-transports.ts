import type { Class } from "../components/injection.js";
import type { TransportResolver } from "../llm/provider-chat.js";
import type { ModelProviderHandler } from "../models/handler.js";
import { ModelProviderError } from "../models/model-provider.decorator.js";

/**
 * Transport providers (#385) from the application's one container: the gateway is made before the
 * container, so the container is bound once it exists, and a provider is created on its first use
 * — one instance per application, its `deps` injected.
 */
export interface LateTransports {
  readonly resolve: TransportResolver;
  readonly bind: (resolve: (cls: Class) => unknown) => void;
}

const isHandler = (value: unknown): value is ModelProviderHandler =>
  typeof value === "object" && value !== null;

/** A resolver bound to the container later (`bind`), failing until then. */
export function lateTransports(): LateTransports {
  let resolveClass: ((cls: Class) => unknown) | undefined;
  return {
    resolve: (cls) => {
      if (resolveClass === undefined)
        throw new ModelProviderError(
          `${cls.name}: a transport provider is created by the application's container, which is not ready yet`,
        );
      const instance = resolveClass(cls);
      if (!isHandler(instance))
        throw new ModelProviderError(`${cls.name}: the container gave no provider instance`);
      return instance;
    },
    bind: (resolve) => {
      resolveClass = resolve;
    },
  };
}
