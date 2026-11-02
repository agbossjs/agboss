import { afterEach, describe, it } from "vitest";
import type { RagConnector } from "../../rag/types.js";
import { RAG_CONNECTOR_CASES } from "./rag-connector.cases.js";
import {
  liveSignal,
  type ContractRetrieve,
  type RagCaseContext,
  type RagConnectorContractTarget,
} from "./rag-connector-data.js";

/**
 * `ragConnectorContract(target)` (#700): the rules every knowledge base connector keeps, as the
 * core's reference `SqliteFtsConnector` runs them — registered as `RAG connector contract (<name>)`,
 * each case on a fresh connector: tenant isolation (near-identical ids too), re-indexing that
 * replaces, `topK`, the abort signal, a cost the ledger can add, well-formed results.
 *
 * `ragConnectorContract({ name: "pgvector", connector: () => new MyConnector(pool), documents: (c, tenantId, docs) => seed(tenantId, docs), reset: truncate })`
 */
export function ragConnectorContract<TConnector extends RagConnector>(
  target: RagConnectorContractTarget<TConnector>,
): void {
  describe(`RAG connector contract (${target.name})`, () => {
    if (target.reset !== undefined) afterEach(target.reset);
    for (const contractCase of RAG_CONNECTOR_CASES) {
      it(contractCase.name, async () => {
        await contractCase.run(await contextOf(target));
      });
    }
  });
}

/** A case's connector, how it is filled, and how it is asked. */
async function contextOf<TConnector extends RagConnector>(
  target: RagConnectorContractTarget<TConnector>,
): Promise<RagCaseContext> {
  const connector = await target.connector();
  const fill: RagCaseContext["fill"] = async (tenantId, documents) => {
    await target.documents(connector, tenantId, documents);
    await connector.index?.({ tenantId, signal: liveSignal() });
  };
  const retrieve: ContractRetrieve = (query, options) => connector.retrieve(query, options);
  return { connector, fill, retrieve };
}
