import { recordComponent } from "../components/metadata.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { resolvedName } from "../flow/names.js";
import type { RerankFailurePolicy } from "./types.js";

/**
 * `@RagReranker`: what re-orders a knowledge base's candidates before the agent reads them — bound
 * by `@Rag({ reranker })`. An empty class is the core's LLM reranker on the cascade's model; a class
 * with a `rerank(query, candidates, options)` method is your own (a dedicated rerank API on its
 * official SDK, or plain code), created by the container with its `deps`.
 */
export interface RagRerankerOptions<D extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out (`DocsReranker` → `docs-reranker`). */
  readonly name?: string;
  readonly description?: string;
  /** How many results the source is asked for, before reranking (`@Rag({ topK })` ≤ `candidates`). */
  readonly candidates: number;
  /** A candidate's text is cut to this many characters for a model reranker (default 1200). */
  readonly maxCandidateLength?: number;
  /** Default `RerankFailurePolicy.FailStep`: a broken reranker fails the step, never degrades silently. */
  readonly onFailure?: RerankFailurePolicy;
  /** A model reranker's model: a role of its provider or a vendor's name; default its provider's. */
  readonly model?: string;
  /** A model reranker's `@ModelProvider`; default the workflow's, else the application's. */
  readonly modelProvider?: Class;
  /** A code reranker's services. */
  readonly deps?: D;
}

/** A `@RagReranker`'s options as recorded: its name resolved and its `deps` always set. */
export type RecordedRerankerMeta = Omit<RagRerankerOptions, "deps" | "name"> & {
  readonly name: string;
  readonly deps: readonly Token[];
};

/** Whether a reranker class is code (it has `rerank()`) or the core's model reranker. */
export const isCodeRerankerClass = (cls: Class): boolean =>
  typeof Reflect.get(cls.prototype as object, "rerank") === "function";

/** A reranker: an empty class (LLM) or one with `rerank()` (code). */
export function RagReranker<const D extends readonly Token[] = []>(options: RagRerankerOptions<D>) {
  return <C extends new (...args: ResolvedAll<D>) => object>(value: C): C => {
    recordComponent(value, {
      kind: "reranker",
      meta: { ...options, name: resolvedName(options.name, value), deps: options.deps ?? [] },
    });
    return value;
  };
}
