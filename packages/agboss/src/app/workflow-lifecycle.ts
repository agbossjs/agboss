import type { ContainerOptions } from "../components/container/container.js";
import type { Token } from "../components/injection.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";

/**
 * A workflow on its own (no application's container: eval, replay, Studio) gets its fenced-effect
 * store from the infrastructure built for it (#890: what `FencedEffects` runs on), a test's own
 * overrides over it.
 */
function standaloneOverridesOf(
  container: ContainerOptions | undefined,
  infrastructure: Infrastructure,
): ReadonlyMap<Token, unknown> | undefined {
  if (container?.application !== undefined) return container.overrides;
  return new Map<Token, unknown>([
    [FencedEffectRepository, infrastructure.fencedEffects],
    ...(container?.overrides ?? []),
  ]);
}

/** The container's options with a hook that collects what it creates, and that list. */
export interface WorkflowLifecycle {
  readonly created: unknown[];
  readonly options: ContainerOptions;
}

/** Collects the container's instances for their lifecycle hooks, keeping any hook already given. */
export function lifecycleOf(
  container: ContainerOptions | undefined,
  infrastructure: Infrastructure,
  created: unknown[] = [],
): WorkflowLifecycle {
  const overrides = standaloneOverridesOf(container, infrastructure);
  const options: ContainerOptions = {
    ...container,
    ...(overrides === undefined ? {} : { overrides }),
    onCreate: (instance) => {
      created.push(instance);
      container?.onCreate?.(instance);
    },
  };
  return { created, options };
}
