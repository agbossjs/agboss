import type { Class } from "../../components/injection.js";
import { requireComponent } from "../../components/metadata.js";
import type { RagSearchResultDto } from "../../dto/standard/framework.js";
import { recordReportedCost } from "../../finops/usage.js";
import type { RagConnector } from "../../rag/types.js";
import { boundRerankerOf, knowledgeRetrieveOf, type RagMeta } from "../../components/rag.js";
import { checkTenancies } from "../../rag/tenancy-checks.js";
import { componentOf } from "../../components/metadata.js";
import { rerankerKeyOf } from "../scripted-gateway.js";
import { unitChatSettings } from "./unit-models.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitModelOptions, UnitRun } from "./unit-types.js";

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
 * `overrides`, the `environment`); each search calls `retrieve(query, { topK, signal, tenantId })` in a
 * step's frame (#700: the unit's tenant, `tenant: { tenantId }`, else `"default"`) — the signal aborts after `timeout` on the runner's clock — and gives its results as
 * `output`, its reported `costUsd` as `spend` (`rag:<name>`, as an agent's search is billed).
 */
export function testRag<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  rag: Class<RagConnector>,
  options: UnitModelOptions<unknown, TExecution, TTenant> = {},
): RagRunner {
  const { meta } = requireComponent(rag, "rag", "testRag");
  checkTenancies([meta]); // #796: as assembly does
  const site = new UnitSite(options);
  const reranker = rerankerOf(meta, site, options);
  const caller = `rag:${meta.name}`;
  const run = async (query: string, call: RagCallOptions = {}) => {
    // the container creates the class itself: an instance of the knowledge base
    const connector = site.instanceOf(rag) as RagConnector;
    const frame = { component: rag, caller, ...callTimeoutOf(call.timeout) };
    return site.run(frame, async ({ signal, spent }) => {
      // the unit's tenant, as an execution's search passes it (#700), reranked as it would be (#703)
      const retrieve = knowledgeRetrieveOf(meta, connector, reranker);
      const retrieval = await retrieve(query, { topK: call.topK ?? meta.topK, signal });
      spent.push(
        recordReportedCost({ name: meta.name, costCaller: caller }, retrieval.costUsd ?? 0),
        ...(retrieval.usage ?? []),
      );
      return retrieval.results;
    });
  };
  return Object.assign(run, { clock: site.clock });
}

/**
 * The knowledge base's reranker on the runner (#703): a code one created by its container, a model
 * one on the runner's scripts — `model: replyWith('{"ranking":[2,1]}')`; unscripted, it ranks
 * nothing (the retrieval's order).
 */
function rerankerOf(meta: RagMeta, site: UnitSite, options: UnitModelOptions) {
  const by = meta.rerank?.by;
  const found = by === undefined ? undefined : componentOf(by);
  if (found?.kind === "reranker")
    site.scriptModel(rerankerKeyOf(found.meta.name), found.meta.name, options.model);
  return boundRerankerOf(meta, (cls) => site.instanceOf(cls), {
    router: () => {
      throw new TypeError("testRag: no router");
    },
    rerankModel: (reranker, model) => {
      const settings = unitChatSettings(model);
      const chat = site.gateway.chatModel({ user: { kind: "reranker", reranker }, settings });
      return { model: chat, settings };
    },
  });
}
