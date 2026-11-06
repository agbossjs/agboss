import type { RagSearchResultDto } from "../../dto/standard/framework.js";
import type { RagConnector, RagRetrieval, RagTenancy, RerankerHandler } from "../../rag/types.js";

/**
 * What the RAG connector contract (#700) runs on: the target a connector's own suite gives, the
 * documents and tenant ids of its cases.
 */

/** One document as the suite hands it to the connector's source. */
export interface RagContractDocument {
  /** Where it comes from: what a result cites (`hours.md`). */
  readonly source: string;
  readonly text: string;
}

/** The connector under test and how its knowledge base is filled. */
export interface RagConnectorContractTarget<TConnector extends RagConnector = RagConnector> {
  /** Names the suite: `RAG connector contract (<name>)`. */
  readonly name: string;
  /**
   * Whose content the connector serves, as its `@Rag({ tenancy })` says (#818); default
   * `RagTenancy.PerTenant`: each tenant's own passages, never another's. `RagTenancy.Shared`: one
   * corpus every tenant reads — the suite checks that every tenant gets the same results and that
   * every call still carries the tenant it is made for, in place of the isolation cases.
   */
  readonly tenancy?: RagTenancy;
  /** A connector over an empty knowledge base — a new one for every case. */
  readonly connector: () => TConnector | Promise<TConnector>;
  /**
   * Makes `documents` the whole source of tenant `tenantId`'s knowledge base, replacing what was
   * there (a folder's files, a bucket): the suite calls the connector's `index({ tenantId })` next.
   * A connector without `index` makes them searchable here. Under `RagTenancy.Shared` they are the
   * one corpus, whatever `tenantId` says.
   */
  readonly documents: (
    connector: TConnector,
    tenantId: string,
    documents: readonly RagContractDocument[],
  ) => Promise<void>;
  /** After each case: drop what it stored. */
  readonly reset?: () => Promise<void>;
  /**
   * Run every case through the core's reranking (#703): the connector asked for `candidates` (at
   * least the case's `topK`), `by` reranking them, the case's `topK` kept — as an agent's search runs.
   */
  readonly rerank?: { readonly by: RerankerHandler; readonly candidates: number };
}

/** A retrieval of the suite: the connector's own, or through the core's seam around it (#703). */
export type ContractRetrieve = (
  query: string,
  options: { readonly topK: number; readonly tenantId: string; readonly signal: AbortSignal },
) => Promise<RagRetrieval>;

/** Which call reached the connector or the reranker, and for which tenant (#818). */
export interface ObservedRagCall {
  readonly call: "retrieve" | "index" | "rerank";
  readonly tenantId: string;
}

/** What one case is given. */
export interface RagCaseContext<TConnector extends RagConnector = RagConnector> {
  readonly connector: TConnector;
  /** Every call the connector (and the reranker) received so far, in order. */
  readonly calls: readonly ObservedRagCall[];
  /** Fills a tenant's knowledge base and indexes it (when the connector has an index). */
  readonly fill: (tenantId: string, documents: readonly RagContractDocument[]) => Promise<void>;
  readonly retrieve: ContractRetrieve;
}

/** One rule of the contract. */
export interface RagContractCase {
  readonly name: string;
  /** The tenancies the rule holds for (#818). */
  readonly tenancies: readonly RagTenancy[];
  readonly run: (context: RagCaseContext) => Promise<void>;
}

/**
 * Tenant ids the key-text rules accept (#538, #552), none the case, width, NFC or accent form of
 * another — a connector that compares them folded (a case-insensitive collation, NFKC, an
 * accent-blind index) makes two of them one tenant.
 */
export const NEAR_IDENTICAL_TENANTS: readonly string[] = [
  "acme",
  "Acme",
  "ACME",
  "ａｃｍｅ",
  "acme:1",
  "acme:１",
  "café",
  "cafe",
  "straße",
  "strasse",
  "q̇",
  "q",
  "tenant/a",
  "tenant%2Fa",
  "k".repeat(200),
];

/** A word no other document of a case has, for the tenant at `index`: `marker` + letters. */
export const markerOf = (index: number): string =>
  `marker${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`;

/** A signal that never aborts. */
export const liveSignal = (): AbortSignal => new AbortController().signal;

/** The texts of a retrieval's results. */
export const textsOf = (results: readonly RagSearchResultDto[]): readonly string[] =>
  results.map((result) => result.text);

/** Whether a cost is one the ledger can add: absent (free) or a finite number from 0. */
export const isLedgerCost = (cost: number | undefined): boolean =>
  cost === undefined || (Number.isFinite(cost) && cost >= 0);
