import "../polyfills/symbol-metadata.js";

/**
 * Knowledge bases (RAG): `@Rag` on a `RagSource`, the search DTOs, the reranker decorator and the
 * reference source (Wiki → Knowledge bases). A reranker's author needs this entry only.
 */
export { Rag, type RagOptions } from "../components/decorators.js";
export {
  RagQueryDto,
  RagSearchResultDto,
  RagSearchResultsDto,
  RagSourceReferenceDto,
} from "./dto.js";
export { RagSource } from "./rag-source.js";
export { RagScope, RerankFailurePolicy } from "./types.js";
export type {
  RagIndexOptions,
  RagIndexReport,
  RagRetrieval,
  RagRetrieveOptions,
  RagSearchOptions,
  RerankOptions,
  RerankResult,
} from "./types.js";
export {
  RagReranker,
  type CodeRagRerankerOptions,
  type ModelRagRerankerOptions,
  type RagRerankerOptions,
} from "./reranker.decorator.js";
export { SqliteFtsRagSource, type SqliteFtsOptions } from "./sqlite-fts.js";
export type { SqliteFtsDirectory, SqliteFtsDirectoryKey } from "./sqlite-fts-directory.js";
