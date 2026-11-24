import { ComponentOptions } from "../components/component-options.js";
import type { Class } from "../components/injection.js";
import { Ttl } from "../units/index.js";
import type { HistorySources } from "./app-deps-parts.js";

/**
 * What a workflow's history keeper reads (#1318): the application's history store, unless the workflow
 * keeps none — its `historyTtl` under the profiles it was assembled with is `Ttl.None`, so no record of
 * its trees is saved and the thread's status history goes with its tree.
 */
export function historySourcesOf<TSources extends HistorySources>(
  sources: TSources,
  bundle: {
    readonly componentOptions?: ComponentOptions | undefined;
    readonly graph: { readonly type: Class };
  },
): TSources {
  const options = bundle.componentOptions ?? ComponentOptions.none;
  return options.historyTtlOf(bundle.graph.type) === Ttl.None
    ? { ...sources, executionHistory: undefined }
    : sources;
}
