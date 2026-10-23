import type { ModelProviderHandler } from "../handler.js";
import type { ModelProviderType } from "../model-provider.decorator.js";

/**
 * Transport providers (#385) from the application's one container — one instance per application,
 * its `deps` injected.
 */
export interface TransportResolver {
  /** The instance as a component of the start (the model check at start): its hooks run with theirs. */
  readonly instanceOf: (cls: ModelProviderType) => ModelProviderHandler;
  /**
   * The instance for a call (#385 S4): created on the first, its `onInit` → `onStart` (and those of
   * the dependencies created with it) awaited before; concurrent first calls share one creation, a
   * failed one is tried again by the next call.
   */
  readonly started: (cls: ModelProviderType) => Promise<ModelProviderHandler>;
}
