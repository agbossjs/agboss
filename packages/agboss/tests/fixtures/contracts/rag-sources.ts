import { usd, type Usd } from "../../../src/units/index.js";
import { RagSource } from "../../../src/rag/rag-source.js";
import type {
  RagIndexReport,
  RagIndexOptions,
  RagRetrieval,
  RagRetrieveOptions,
} from "../../../src/rag/types.js";
import type {
  RagSourceContractTarget,
  RagContractDocument,
} from "../../../src/testing/contracts/index.js";

/**
 * In-memory connectors for the RAG contract's bite proofs (#700): one that keeps the contract, and
 * one per way of breaking a rule — each a small override of the sound one.
 */

/** What a variant changes: how a tenant is keyed, how an index lands, what a retrieval gives. */
export interface ConnectorFlaws {
  readonly keyOf?: (scopeId: string) => string;
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
export class MemorySource extends RagSource {
  readonly sources = new Map<string, readonly RagContractDocument[]>();
  private readonly chunks = new Map<string, RagContractDocument[]>();

  constructor(private readonly flaws: ConnectorFlaws = {}) {
    super();
  }

  setDocuments(scopeId: string, documents: readonly RagContractDocument[]): void {
    this.sources.set(this.sourceKey(scopeId), documents);
  }

  protected override index({ scopeId, signal }: RagIndexOptions): Promise<RagIndexReport> {
    if (this.flaws.ignoresSignal !== true) signal.throwIfAborted();
    const key = this.key(scopeId ?? "");
    const documents = this.sources.get(this.sourceKey(scopeId ?? "")) ?? [];
    const kept = this.flaws.appendsOnReindex === true ? (this.chunks.get(key) ?? []) : [];
    this.chunks.set(key, [...kept, ...documents]);
    return Promise.resolve({
      documents: documents.length,
      chunks: this.chunks.get(key)?.length ?? 0,
      skipped: 0,
      costUsd: (this.flaws.costUsd ?? 0) as Usd,
    });
  }

  protected override retrieve(query: string, options: RagRetrieveOptions): Promise<RagRetrieval> {
    if (this.flaws.ignoresSignal !== true) options.signal.throwIfAborted();
    const words = new Set(wordsOf(query));
    const asker = options.scopeId ?? "";
    const own = this.key(asker);
    if (this.flaws.copiesPerTenant === true && !this.chunks.has(own))
      this.chunks.set(own, [...(this.sources.get(this.sourceKey(asker)) ?? [])]);
    const scored = (this.chunks.get(own) ?? [])
      .map((chunk) => ({ chunk, score: wordsOf(chunk.text).filter((w) => words.has(w)).length }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    const taken = this.flaws.ignoresTopK === true ? scored : scored.slice(0, options.topK);
    return Promise.resolve({
      results: taken.map(({ chunk, score }) => ({ ...chunk, score })),
      costUsd: (this.flaws.costUsd ?? 0) as Usd,
    });
  }

  private sourceKey(scopeId: string): string {
    return this.flaws.copiesPerTenant === true ? "shared" : this.key(scopeId);
  }

  private key(scopeId: string): string {
    return this.flaws.keyOf?.(scopeId) ?? scopeId;
  }
}

/** The target of one variant, for `ragSourceContract`. */
export const memoryTarget = (
  name: string,
  flaws: ConnectorFlaws = {},
): RagSourceContractTarget<MemorySource> => ({
  name,
  source: () => new MemorySource(flaws),
  documents: (
    source: MemorySource,
    scopeId: string,
    documents: readonly RagContractDocument[],
  ): Promise<void> => {
    source.setDocuments(scopeId, documents);
    return Promise.resolve();
  },
});
