import { startComponents } from "../components/container/lifecycle.js";
import type { Class } from "../components/injection.js";
import type { ModelProviderHandler } from "../models/handler.js";
import { ModelProviderError } from "../models/model-provider.decorator.js";
import type { TransportResolver } from "../models/transport/transport-resolver.js";

/**
 * Transport providers (#385) from the application's one container: the gateway is made before the
 * container, so the container is bound once it exists, and a provider is created on its first call
 * — one instance per application, its `deps` injected. A provider created then runs its lifecycle
 * like any component (#385 S4): `onInit` → `onStart` (its and those of the dependencies created
 * with it) before its first `complete()`, `onStop` / `onDestroy` at `app.close()`.
 */

/** The application's container as the transports need it: its instances and what it created. */
export interface TransportContainer {
  readonly resolve: (cls: Class) => unknown;
  /** Every instance the container created, in order: what the application starts and stops. */
  readonly created: unknown[];
}

export interface LateTransports {
  readonly resolver: TransportResolver;
  readonly bind: (container: TransportContainer) => void;
}

const isHandler = (value: unknown): value is ModelProviderHandler =>
  typeof value === "object" && value !== null;

/** A resolver bound to the container later (`bind`), failing until then. */
export function lateTransports(): LateTransports {
  let container: TransportContainer | undefined;
  /** One creation per class: concurrent first calls share it; a failed one is dropped. */
  const creations = new Map<Class, Promise<ModelProviderHandler>>();
  /** What a failed creation made but could not start: the next creation starts it. */
  let unstarted: unknown[] = [];
  const bound = (cls: Class): TransportContainer => {
    if (container === undefined)
      throw new ModelProviderError(
        `${cls.name}: a transport provider is created by the application's container, which is not ready yet`,
      );
    return container;
  };
  const instanceOf = (cls: Class): ModelProviderHandler => {
    const instance = bound(cls).resolve(cls);
    if (!isHandler(instance))
      throw new ModelProviderError(`${cls.name}: the container gave no provider instance`);
    return instance;
  };
  // the hooks of what this call created, before its first complete(); kept for app.close() once started
  const create = async (cls: Class): Promise<ModelProviderHandler> => {
    const { created } = bound(cls);
    const before = created.length;
    const instance = instanceOf(cls);
    const fresh = [...unstarted, ...created.splice(before)];
    unstarted = [];
    try {
      await startComponents(fresh);
    } catch (error) {
      unstarted = fresh;
      throw error;
    }
    created.push(...fresh);
    return instance;
  };
  const started = (cls: Class): Promise<ModelProviderHandler> => {
    const known = creations.get(cls);
    if (known !== undefined) return known;
    const creation = create(cls);
    creations.set(cls, creation);
    void creation.catch(() => creations.delete(cls));
    return creation;
  };
  return {
    resolver: { instanceOf, started },
    bind: (given) => {
      container = given;
    },
  };
}
