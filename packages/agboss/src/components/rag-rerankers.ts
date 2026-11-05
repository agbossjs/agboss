import { DecidedBy } from "../flow/decorators/router.js";
import type { RecordedRerankerMeta } from "../rag/reranker.decorator.js";
import { DEFAULT_RERANKER_MODEL } from "../rag/types.js";
import type { Class } from "./injection.js";
import { componentOf } from "./metadata.js";
import { ragMeta, type RagMeta } from "./rag.js";

/** The `@Reranker` meta of a knowledge base's `rerank.by`; none without `rerank`. */
export const rerankerMetaOf = (meta: RagMeta): RecordedRerankerMeta | undefined => {
  const found = meta.rerank === undefined ? undefined : componentOf(meta.rerank.by);
  return found?.kind === "reranker" ? found.meta : undefined;
};

/** The `@Reranker` classes of knowledge bases, for the container (#703). */
export const rerankerClassesOf = (rags: readonly Class[]): Class[] =>
  rags.flatMap((cls) => {
    const by = ragMeta(cls).rerank?.by;
    return by === undefined ? [] : [by];
  });

/** A model reranker's model: its own, else the default (#703). */
export const rerankerModelsOf = (
  rags: readonly Class[],
): readonly { readonly name: string; readonly model: string }[] =>
  [
    ...new Map(
      rags.flatMap((cls) => {
        const reranker = rerankerMetaOf(ragMeta(cls));
        if (reranker === undefined || reranker.decidedBy === DecidedBy.Code) return [];
        return [[reranker.name, reranker.model ?? DEFAULT_RERANKER_MODEL] as const];
      }),
    ),
  ].map(([name, model]) => ({ name, model }));
