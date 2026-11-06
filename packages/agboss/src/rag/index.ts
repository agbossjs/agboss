import "../polyfills/symbol-metadata.js";

/**
 * Knowledge bases (RAG): the connector contract and the reference implementation (Wiki → Knowledge
 * bases). A reranker's author needs this entry only: `DecidedBy` and `RagSearchResultDto` are here
 * too (the same as the root's and `/dto`'s).
 */
export { Rag } from "../components/decorators.js";
export { DecidedBy } from "../flow/decorators/router.js";
export type { RagSearchResultDto } from "../dto/standard/framework.js";
export {
  DEFAULT_RERANKER_MODEL,
  ModelReranker,
  RagMode,
  RagTenancy,
  RerankFailurePolicy,
} from "./types.js";
export type {
  RagConnector,
  RagIndexOptions,
  RagIndexReport,
  RagRerank,
  RagRetrieval,
  RagRetrieveOptions,
  RerankerClass,
  RerankerHandler,
  RerankOptions,
  RerankResult,
} from "./types.js";
export {
  Reranker,
  type CodeRerankerMeta,
  type ModelRerankerMeta,
  type RerankerMeta,
} from "./reranker.decorator.js";
export { RerankFailedError, type RerankFailedErrorOptions } from "./rerank.js";
export { SqliteFtsConnector, type SqliteFtsOptions } from "./sqlite-fts.js";
