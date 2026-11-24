import type { Class } from "../../components/injection.js";
import { requireComponent } from "../../components/metadata.js";
import { componentOf } from "../../components/metadata.js";
import type { RagSearchResultDto } from "../../rag/dto.js";
import { retrievalRecordsOf } from "../../rag/retrieval-spend.js";
import { ragRuntimeOf, type RagSource } from "../../rag/rag-source.js";
import { checkRags } from "../../rag/rag-checks.js";
import { rerankerKeyOf } from "../scripted-gateway.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

/** What one search of a unit runner takes besides its query. */
export interface RagCallOptions extends UnitCallOptions {
  /** How many results it asks for; default the `@Rag({ topK })`. */
  readonly topK?: number;
  /** What the source's `retrieve` gets as `options.filter`. */
  readonly filter?: unknown;
}

/** One knowledge base searched: `await search("remote TypeScript")` → `{ output, spend }`. */
export interface RagRunner extends UnitClock {
  (query: string, options?: RagCallOptions): Promise<UnitRun<readonly RagSearchResultDto[]>>;
}

/**
 * A `@Rag` knowledge base on its own: created by its own container (its `deps`, `overrides`, the
 * `environment`); each search runs the framework's pipeline in a step's frame — the unit's scope
 * (`tenant: { tenantId }`, else `"default"`; `ownerId` for `RagScope.Owner`), the reranker, the
 * signal that aborts after `timeout` on the runner's clock — and gives its results as `output`, its
 * reported cost and tokens as `spend` (`rag:<name>`, as an agent's search is billed).
 */
export function ragUnit<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  rag: Class<RagSource<never, never>>,
  options: UnitModelOptions<unknown, TExecution, TTenant> = {},
): RagRunner {
  const { meta } = requireComponent(rag, "rag", "testUnit");
  checkRags([rag]); // as assembly does
  const site = new UnitSite(options);
  const found = meta.reranker === undefined ? undefined : componentOf(meta.reranker);
  if (found?.kind === "reranker")
    site.scriptModel(rerankerKeyOf(found.meta.name), found.meta.name, options.model);
  const caller = `rag:${meta.name}`;
  const run = async (query: string, call: RagCallOptions = {}) => {
    // the container creates the class itself: an instance of the knowledge base, with its pipeline
    const source = site.instanceOf(rag);
    const runtime = ragRuntimeOf(source as object);
    const frame = { component: rag, caller, ...callTimeoutOf(call.timeout) };
    return site.run(frame, async ({ signal, spent }) => {
      if (runtime === undefined) throw new TypeError(`testUnit: ${rag.name} is no RagSource`);
      const retrieval = await runtime.retrieve(query, {
        topK: call.topK ?? meta.topK,
        signal,
        ...(call.filter === undefined ? {} : { filter: call.filter }),
      });
      spent.push(...retrievalRecordsOf(meta.name, retrieval));
      return retrieval.results;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
