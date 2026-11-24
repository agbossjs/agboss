import { recordOptionKeys } from "../components/option-keys.js";
import { RAG_RERANKER_KEYS } from "../components/decorator-options.js";
import { callerFile } from "../components/call-site.js";
import { recordComponent } from "../components/metadata.js";
import type { PromptSource } from "../components/prompt-source.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { resolvedName } from "../flow/names.js";
import type { RerankFailurePolicy } from "./types.js";

/**
 * `@RagReranker`: what re-orders a knowledge base's candidates before the agent reads them — bound
 * by `@Rag({ reranker })`. An empty class is the core's LLM reranker on the cascade's model; a class
 * with a `rerank(query, candidates, options)` method is your own (a dedicated rerank API on its
 * official SDK, or plain code), created by the container with its `deps`.
 */
export interface RagRerankerBase {
  /** Kebab-case; the class name in kebab-case when left out (`DocsReranker` → `docs-reranker`). */
  readonly name?: string;
  readonly description?: string;
  /** How many results the source is asked for, before reranking (`@Rag({ topK })` ≤ `candidates`). */
  readonly candidates: number;
  /** A candidate's text is cut to this many characters for a model reranker (default 1200). */
  readonly maxCandidateLength?: number;
  /** Default `RerankFailurePolicy.FailStep`: a broken reranker fails the step, never degrades silently. */
  readonly onFailure?: RerankFailurePolicy;
}

/** `@RagReranker` on a class with `rerank()`: your own code reranker — no model, no prompt. */
export interface CodeRagRerankerOptions<
  D extends readonly Token[] = readonly Token[],
> extends RagRerankerBase {
  /** A code reranker's services. */
  readonly deps?: D;
  readonly model?: never;
  readonly modelProvider?: never;
  readonly prompt?: never;
}

/** `@RagReranker` on an empty class: the core's LLM reranker on the cascade's model. */
export interface ModelRagRerankerOptions extends RagRerankerBase {
  /** A model reranker's model: a role of its provider or a vendor's name; default its provider's. */
  readonly model?: string;
  /** A model reranker's `@ModelProvider`; default the workflow's, else the application's. */
  readonly modelProvider?: Class;
  /** What the model is told besides the ranking task: a `.prompt.md` file next to the class (`./…`), `inline(…)` or a list of them (#1347). */
  readonly prompt?: PromptSource;
  readonly deps?: never;
}

/** `@RagReranker` options: a model's or a code one's. */
export type RagRerankerOptions<D extends readonly Token[] = readonly Token[]> =
  ModelRagRerankerOptions | CodeRagRerankerOptions<D>;

/** A `@RagReranker`'s options as recorded: its name resolved and its `deps` always set. */
export type RecordedRerankerMeta = Omit<ModelRagRerankerOptions, "deps" | "name"> & {
  readonly name: string;
  readonly deps: readonly Token[];
  /** Where the class was declared: a prompt file is read relative to it. */
  readonly source?: string;
};

/** Whether a reranker class is code (it has `rerank()`) or the core's model reranker. */
export const isCodeRerankerClass = (cls: Class): boolean =>
  typeof Reflect.get(cls.prototype as object, "rerank") === "function";

/** A reranker on the core's LLM: an empty class. */
export function RagReranker(
  options: ModelRagRerankerOptions,
): <C extends new () => object>(value: C) => C;
/** A reranker of your own: a class with `rerank()`, `deps` in its constructor. */
export function RagReranker<const D extends readonly Token[] = []>(
  options: CodeRagRerankerOptions<D>,
): <C extends new (...args: ResolvedAll<D>) => object>(value: C) => C;
export function RagReranker(
  options: RagRerankerOptions,
): <C extends new (...args: never[]) => object>(value: C) => C {
  const source = callerFile();
  return <C extends new (...args: never[]) => object>(value: C): C => {
    recordOptionKeys(value, "RagReranker", options, RAG_RERANKER_KEYS);
    recordComponent(value, {
      kind: "reranker",
      meta: {
        ...options,
        name: resolvedName(options.name, value),
        deps: options.deps ?? [],
        ...(source === undefined ? {} : { source }),
      },
    });
    return value;
  };
}
