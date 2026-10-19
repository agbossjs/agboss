import type { Class } from "../../components/injection.js";
import { requireComponent } from "../../components/metadata.js";
import type { RagSearchResultDto } from "../../dto/standard/framework.js";
import { recordReportedCost } from "../../finops/usage.js";
import type { RagConnector } from "../../rag/types.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** What one search of a unit runner takes besides its query. */
export interface RagCallOptions extends UnitCallOptions {
  /** How many results it asks for; default the `@Rag({ topK })`. */
  readonly topK?: number;
}

/** One knowledge base searched: `await search("remote TypeScript")` → `{ output, spend }`. */
export interface RagRunner extends UnitClock {
  (query: string, options?: RagCallOptions): Promise<UnitRun<readonly RagSearchResultDto[]>>;
}

/**
 * A `@Rag` knowledge base on its own (#262 S89, S95): created by its own container (its `deps`,
 * `overrides`, the `environment`); each search calls `retrieve(query, { topK, signal })` in a
 * step's frame — the signal aborts after `timeout` on the runner's clock — and gives its results as
 * `output`, its reported `costUsd` as `spend` (`rag:<name>`, as an agent's search is billed).
 */
export function testRag<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(rag: Class<RagConnector>, options: UnitOptions<TExecution, TTenant> = {}): RagRunner {
  const { meta } = requireComponent(rag, "rag", "testRag");
  const site = new UnitSite(options);
  const caller = `rag:${meta.name}`;
  const run = async (query: string, call: RagCallOptions = {}) => {
    // the container creates the class itself: an instance of the knowledge base
    const connector = site.instanceOf(rag) as RagConnector;
    const frame = { component: rag, caller, ...callTimeoutOf(call.timeout) };
    return site.run(frame, async ({ signal, spent }) => {
      const retrieval = await connector.retrieve(query, { topK: call.topK ?? meta.topK, signal });
      spent.push(
        recordReportedCost({ name: meta.name, costCaller: caller }, retrieval.costUsd ?? 0),
      );
      return retrieval.results;
    });
  };
  return Object.assign(run, { clock: site.clock });
}
