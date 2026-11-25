import { ConfigError } from "../core/error-families/config-errors.js";
import type { ModelCascade } from "../models/model-cascade.js";
import { componentModelOf, modelResolverOf, type ModelResolver } from "../models/model-resolver.js";
import type { BoundReranker } from "../rag/rerank.js";
import { isCodeRerankerClass, type RecordedRerankerMeta } from "../rag/reranker.decorator.js";
import type { PromptLoader } from "./prompt-render.js";
import { RerankFailurePolicy } from "../rag/types.js";
import type { WorkflowServices } from "../workflow.js";
import type { Class } from "./injection.js";
import { ragMeta, rerankedBy, type RagMeta } from "./rag.js";

/** A model reranker's model as the cascade resolves it, the provider that serves it and its price mark. */
export interface ResolvedRerankerModel {
  readonly name: string;
  readonly model: string;
  readonly modelProvider?: string;
  /** Its provider has no `cost` (#1313): its calls are 0 USD records with their tokens. */
  readonly unpriced?: true;
  /** Its `prompt` as assembly read it (#1347); `""` when it has none. */
  readonly prompt?: string;
}

/**
 * A model reranker's model through the workflow's cascade resolver, like every other model use
 * (`ragRerankers.<name>`, bughunt 2026-11-25 #6): its own `modelProvider` and `model`, a profile's
 * override of either, a profile's `modelProviders` overlay of the provider's model names, and the
 * levels' `defaults.models.model` — never the declared provider options alone.
 */
function rerankerModelOf(
  resolver: ModelResolver,
  declared: { readonly name: string; readonly model?: string; readonly modelProvider?: Class },
): ResolvedRerankerModel {
  return {
    name: declared.name,
    ...componentModelOf(resolver, `ragRerankers.${declared.name}`, {
      model: declared.model,
      provider: declared.modelProvider,
      isRequired: true,
    }),
  };
}

/** The model rerankers of knowledge bases, each once: its class and what it declares. */
function modelRerankersOf(rags: readonly Class[]): ReadonlyMap<string, RecordedRerankerMeta> {
  const found = new Map<string, RecordedRerankerMeta>();
  for (const rag of rags) {
    const reranked = rerankedBy(ragMeta(rag));
    if (reranked === undefined || isCodeRerankerClass(reranked.cls)) continue;
    if (!found.has(reranked.meta.name)) found.set(reranked.meta.name, reranked.meta);
  }
  return found;
}

/**
 * The model rerankers' models of knowledge bases, once each, resolved through the cascade: on the
 * workflow's resolver at assembly (its violations thrown with the other model uses' by its `check`),
 * else on a resolver of `cascade` of their own, checked here.
 */
export function rerankerModelsOf(
  rags: readonly Class[],
  cascade: ModelCascade = {},
  prompts: ReadonlyMap<string, string> = new Map(),
  shared?: ModelResolver,
): readonly ResolvedRerankerModel[] {
  const resolver = shared ?? modelResolverOf("rerankers", cascade);
  const all = [...modelRerankersOf(rags).values()].map((meta) => rerankerModelOf(resolver, meta));
  if (shared === undefined) resolver.check();
  return all.map((one) => {
    const prompt = prompts.get(one.name) ?? "";
    return prompt === "" ? one : { ...one, prompt };
  });
}

/**
 * Every model reranker's `prompt`, read at assembly like any prompt (#1347): a `./` file relative to
 * the file that declared the reranker, `inline(…)`, or a list of them, with the workflow's variables.
 * A problem is the loader's, reported with the agent prompts' at once. By the reranker's name.
 */
export async function rerankerPromptsOf(
  rags: readonly Class[],
  loader: PromptLoader,
): Promise<ReadonlyMap<string, string>> {
  const found = new Map<string, RecordedRerankerMeta>();
  for (const rag of rags) {
    const reranked = rerankedBy(ragMeta(rag));
    if (reranked === undefined || isCodeRerankerClass(reranked.cls)) continue;
    found.set(reranked.meta.name, reranked.meta);
  }
  const loaded = await Promise.all(
    [...found].map(async ([name, meta]): Promise<[string, string]> => [
      name,
      await loader.load({
        label: `@RagReranker "${name}"`,
        options: { prompt: meta.prompt },
        source: meta.source,
      }),
    ]),
  );
  return new Map(loaded);
}

/** A knowledge base's reranker as the core runs it; none without `reranker`. */
export function boundRerankerOf(
  meta: RagMeta,
  instance: (cls: Class) => unknown,
  services: WorkflowServices,
  cascade: ModelCascade = {},
): BoundReranker | undefined {
  const reranked = rerankedBy(meta);
  if (reranked === undefined) return undefined;
  const { cls, meta: reranker } = reranked;
  const isCode = isCodeRerankerClass(cls);
  const binding = () => {
    // the cascade's resolver, as at assembly: a profile's overlay and override reach the call too
    const resolver = modelResolverOf(meta.name, cascade);
    const resolved = rerankerModelOf(resolver, reranker);
    resolver.check();
    if (services.rerankModel === undefined)
      throw new ConfigError.Component({
        message: `[reranker.no-model-gateway] ${reranker.name}: no model gateway here`,
      });
    return services.rerankModel(resolved);
  };
  return {
    rag: meta.name,
    reranker: reranker.name,
    candidates: reranker.candidates,
    maxCandidateLength: reranker.maxCandidateLength,
    instructions: services.rerankInstructions?.(reranker.name) ?? "",
    onFailure: reranker.onFailure ?? RerankFailurePolicy.FailStep,
    source: isCode
      ? { kind: "code", instance: () => instance(cls) as never }
      : { kind: "model", binding },
  };
}
