import "../polyfills/symbol-metadata.js";

/** Knowledge bases (RAG): the connector contract and the reference implementation (Wiki → Knowledge bases). */
export { Rag } from "../components/decorators.js";
export { DEFAULT_RERANKER_MODEL, RagMode, RagTenancy, RerankFailurePolicy } from "./types.js";
export type {
  IndexReport,
  KnowledgeRetrieve,
  KnowledgeSource,
  RagConnector,
  RagIndexOptions,
  RagRetrieval,
  RagRerank,
  RagReranking,
  RagRetrieveOptions,
  KnowledgeRetrieval,
  RerankerHandler,
  RerankOptions,
} from "./types.js";
export {
  Reranker,
  type CodeRerankerMeta,
  type ModelRerankerMeta,
  type RerankerMeta,
} from "./reranker.decorator.js";
export { RerankFailedError } from "./rerank.js";
export { SqliteFtsConnector, type FtsOptions } from "./sqlite-fts.js";
