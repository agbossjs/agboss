import type {
  RagIndexReport,
  RagConnector,
  RagIndexOptions,
  RagRetrieval,
  RagRetrieveOptions,
} from "../../../src/rag/types.js";
import type {
  RagConnectorContractTarget,
  RagContractDocument,
} from "../../../src/testing/contracts/index.js";

/**
 * In-memory connectors for the RAG contract's bite proofs (#700): one that keeps the contract, and
 * one per way of breaking a rule — each a small override of the sound one.
 */

/** What a variant changes: how a tenant is keyed, how an index lands, what a retrieval gives. */
export interface ConnectorFlaws {
  readonly keyOf?: (tenantId: string) => string;
  readonly appendsOnReindex?: boolean;
  /** One source, a copy per tenant: taken at a tenant's first read, refreshed by its own index only. */
  readonly copiesPerTenant?: boolean;
  readonly ignoresTopK?: boolean;
  readonly ignoresSignal?: boolean;
  readonly costUsd?: number;
}

const wordsOf = (text: string): readonly string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];

/** A knowledge base in memory: a source per tenant, indexed into chunks per tenant. */
export class MemoryConnector implements RagConnector {
  readonly sources = new Map<string, readonly RagContractDocument[]>();
  private readonly chunks = new Map<string, RagContractDocument[]>();

  constructor(private readonly flaws: ConnectorFlaws = {}) {}

  setDocuments(tenantId: string, documents: readonly RagContractDocument[]): void {
    this.sources.set(this.sourceKey(tenantId), documents);
  }

  index({ tenantId, signal }: RagIndexOptions): Promise<RagIndexReport> {
    if (this.flaws.ignoresSignal !== true) signal.throwIfAborted();
    const key = this.key(tenantId);
    const documents = this.sources.get(this.sourceKey(tenantId)) ?? [];
    const kept = this.flaws.appendsOnReindex === true ? (this.chunks.get(key) ?? []) : [];
    this.chunks.set(key, [...kept, ...documents]);
    return Promise.resolve({
      documents: documents.length,
      chunks: this.chunks.get(key)?.length ?? 0,
      skipped: 0,
      costUsd: this.flaws.costUsd ?? 0,
    });
  }

  retrieve(query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    if (this.flaws.ignoresSignal !== true) options.signal.throwIfAborted();
    const words = new Set(wordsOf(query));
    const own = this.key(options.tenantId);
    if (this.flaws.copiesPerTenant === true && !this.chunks.has(own))
      this.chunks.set(own, [...(this.sources.get(this.sourceKey(options.tenantId)) ?? [])]);
    const scored = (this.chunks.get(this.key(options.tenantId)) ?? [])
      .map((chunk) => ({ chunk, score: wordsOf(chunk.text).filter((w) => words.has(w)).length }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    const taken = this.flaws.ignoresTopK === true ? scored : scored.slice(0, options.topK);
    return Promise.resolve({
      results: taken.map(({ chunk, score }) => ({ ...chunk, score })),
      costUsd: this.flaws.costUsd ?? 0,
    });
  }

  private sourceKey(tenantId: string): string {
    return this.flaws.copiesPerTenant === true ? "shared" : this.key(tenantId);
  }

  private key(tenantId: string): string {
    return this.flaws.keyOf?.(tenantId) ?? tenantId;
  }
}

/** The target of one variant, for `ragConnectorContract`. */
export const memoryTarget = (
  name: string,
  flaws: ConnectorFlaws = {},
): RagConnectorContractTarget<MemoryConnector> => ({
  name,
  connector: () => new MemoryConnector(flaws),
  documents: (
    connector: MemoryConnector,
    tenantId: string,
    documents: readonly RagContractDocument[],
  ): Promise<void> => {
    connector.setDocuments(tenantId, documents);
    return Promise.resolve();
  },
});
