import { recordComponent } from "../components/metadata.js";
import type { ResolvedAll, Token } from "../components/injection.js";
import { DecidedBy } from "../flow/decorators/router.js";
import { DEFAULT_RERANKER_MODEL, type ModelReranker, type RerankerHandler } from "./types.js";

/**
 * `@Reranker` (#703): what re-orders a knowledge base's candidates before the agent reads them —
 * bound by `@Rag({ rerank: { by, candidates, topK } })`. By model (the default): the core's LLM
 * reranker on any chat model of the application's providers. By code: your class's `rerank()`
 * (`implements RerankerHandler`), a dedicated rerank API on its official SDK.
 */

/** What every `@Reranker` declares. */
interface RerankerBaseMeta {
  /** `docs-reranker` — kebab-case ending with `-reranker` (`[name.kind-suffix]`). */
  readonly name: string;
  readonly description: string;
}

/** The core's LLM reranker on `model` (`DecidedBy.Model`, the default). */
export interface ModelRerankerMeta extends RerankerBaseMeta {
  readonly decidedBy?: DecidedBy.Model;
  /** A chat model of the application's providers; default `DEFAULT_RERANKER_MODEL`. */
  readonly model?: string;
  readonly deps?: never;
}

/** Your own reranker: the class's `rerank()` (`DecidedBy.Code`), its services through `deps`. */
export interface CodeRerankerMeta<
  D extends readonly Token[] = readonly Token[],
> extends RerankerBaseMeta {
  readonly decidedBy: DecidedBy.Code;
  readonly model?: never;
  readonly deps?: D;
}

/** `@Reranker`'s options. */
export type RerankerMeta = ModelRerankerMeta | CodeRerankerMeta;

/** A `@Reranker`'s options as recorded: its `deps` always set (none for a model one). */
export type RecordedRerankerMeta = (
  Omit<ModelRerankerMeta, "deps"> | Omit<CodeRerankerMeta, "deps">
) & { readonly deps: readonly Token[] };

/** Whether a reranker is decided by its class's code. */
export const isCodeReranker = (meta: RerankerMeta): meta is CodeRerankerMeta =>
  meta.decidedBy === DecidedBy.Code;

/** The model of a model reranker: its own, else the default. */
export const rerankerModelOf = (meta: ModelRerankerMeta): string =>
  meta.model ?? DEFAULT_RERANKER_MODEL;

/** A model reranker: `extends ModelReranker` with no code, decided by the core's LLM reranker on its model. */
export function Reranker(
  options: ModelRerankerMeta,
): <C extends abstract new () => ModelReranker>(value: C) => C;
/** A code reranker: `implements RerankerHandler`, created by the container with its `deps`. */
export function Reranker<const D extends readonly Token[] = []>(
  options: CodeRerankerMeta<D>,
): <C extends new (...args: ResolvedAll<D>) => RerankerHandler>(value: C) => C;
export function Reranker(options: RerankerMeta) {
  return <C extends abstract new (...args: never[]) => object>(value: C): C => {
    const deps: readonly Token[] = isCodeReranker(options) ? (options.deps ?? []) : [];
    recordComponent(value, { kind: "reranker", meta: { ...options, deps } });
    return value;
  };
}
