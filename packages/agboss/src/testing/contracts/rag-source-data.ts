import type { RagSearchResultDto } from "../../rag/dto.js";
import type {
  RagIndexOptions,
  RagIndexReport,
  RagRetrieval,
  RagRetrieveOptions,
  RagScope,
  RerankOptions,
  RerankResult,
} from "../../rag/types.js";

/**
 * What the RAG source contract (#700) runs on: the target a connector's own suite gives, the
 * documents and tenant ids of its cases.
 */

/** One document as the suite hands it to the connector's source. */
export interface RagContractDocument {
  /** Where it comes from: what a result cites (`hours.md`). */
  readonly source: string;
  readonly text: string;
}

/** A source as the suite calls it: its protected `retrieve` and `index` the core reaches. */
export interface ContractSource {
  readonly retrieve: (query: string, options: RagRetrieveOptions<unknown>) => Promise<RagRetrieval>;
  readonly index?: (options: RagIndexOptions) => Promise<RagIndexReport>;
}

/** A code reranker as the suite runs it: a `@RagReranker` class's `rerank`. */
export interface ContractReranker {
  readonly rerank: (
    query: string,
    candidates: readonly RagSearchResultDto[],
    options: RerankOptions,
  ) => RerankResult | Promise<RerankResult>;
}

/** The source under test and how its knowledge base is filled. */
export interface RagSourceContractTarget<TSource extends object = object> {
  /** Names the suite: `RAG source contract (<name>)`. */
  readonly name: string;
  /**
   * Whose content the source serves, as its `@Rag({ scope })` says; default
   * `RagScope.Tenant`: each tenant's own passages, never another's. `RagScope.Shared`: one
   * corpus every tenant reads — the suite checks, in place of the isolation cases, that every tenant
   * gets the same results, a re-index replaces the corpus for all, and an unseen tenant is served.
   */
  readonly scope?: RagScope;
  /** A source over an empty knowledge base — a new one for every case. */
  readonly source: () => TSource | Promise<TSource>;
  /**
   * Makes `documents` the whole source of tenant `scopeId`'s knowledge base, replacing what was
   * there (a folder's files, a bucket): the suite calls the source's `index({ scopeId })` next.
   * A source without `index` makes them searchable here. Under `RagScope.Shared` they are the
   * one corpus, whatever `scopeId` says. `tenantId` is the tenant the scope belongs to: the scope id
   * itself for tenant-scoped sources, and for owner and custom scopes the tenant of the case — the
   * same `scopeId` (one owner id) may be asked about in two tenants, which hold different documents.
   */
  readonly documents: (
    source: TSource,
    scopeId: string,
    documents: readonly RagContractDocument[],
    tenantId: string,
  ) => Promise<void>;
  /** After each case: drop what it stored. */
  readonly reset?: () => Promise<void>;
  /**
   * Run every case through the core's reranking: the source asked for `candidates` (at least the
   * case's `topK`), `by` reranking them, the case's `topK` kept — as an agent's search runs.
   */
  readonly rerank?: { readonly by: ContractReranker; readonly candidates: number };
}

/** A retrieval of the suite: the source's own, or through the core's seam around it. */
export type ContractRetrieve = (
  query: string,
  options: {
    readonly topK: number;
    readonly scopeId: string;
    /** The scope's tenant; default: `scopeId` (a tenant's own scope). */
    readonly tenantId?: string;
    readonly signal: AbortSignal;
  },
) => Promise<RagRetrieval>;

/** The scope id a call to the source carried: none for a shared source. */
type CarriedScope = string | undefined;

/** Which call reached the source or the reranker, and with which scope id. */
export interface ObservedRagCall {
  readonly call: "retrieve" | "index" | "rerank";
  readonly scopeId: CarriedScope;
}

/** What one case is given. */
export interface RagCaseContext {
  readonly source: ContractSource;
  /** Every call the source (and the reranker) received so far, in order. */
  readonly calls: readonly ObservedRagCall[];
  /** Fills a scope's knowledge base and indexes it (when the source has an index). */
  readonly fill: (
    scopeId: string,
    documents: readonly RagContractDocument[],
    tenantId?: string,
  ) => Promise<void>;
  readonly retrieve: ContractRetrieve;
}

/** One rule of the contract. */
export interface RagContractCase {
  readonly name: string;
  /** The scopes the rule holds for (#818). */
  readonly scopes: readonly RagScope[];
  readonly run: (context: RagCaseContext) => Promise<void>;
}

/**
 * Tenant ids the key-text rules accept (#538, #552), none the case, width, NFC or accent form of
 * another — a source that compares them folded (a case-insensitive collation, NFKC, an
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

/** The two plain tenants of the cases. */
export const TENANT_A = "tenant-a";
export const TENANT_B = "tenant-b";

/** A `topK` above every case's corpus: everything that matches. */
export const WIDE = 50;

/** Two documents about leave, the re-index cases' corpus. */
export const DOCS = [
  { source: "leave.md", text: "Leave is twenty five days a year. Leave requests go to the lead." },
  { source: "oncall.md", text: "On-call leave starts after the third month." },
];
