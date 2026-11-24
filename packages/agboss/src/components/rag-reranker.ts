import { GraphRuleError, violation, type RuleViolation } from "../graph/rule-error.js";
import { modelNamedBy, type ModelCascade } from "../models/model-cascade.js";
import { isModelProviderClass, modelProviderOf } from "../models/model-provider.decorator.js";
import type { BoundReranker } from "../rag/rerank.js";
import { isCodeRerankerClass, type RecordedRerankerMeta } from "../rag/reranker.decorator.js";
import type { PromptLoader } from "./prompt-render.js";
import { RerankFailurePolicy } from "../rag/types.js";
import type { WorkflowServices } from "../workflow.js";
import type { Class } from "./injection.js";
import { ComponentError } from "./metadata.js";
import { ragMeta, rerankedBy, type RagMeta } from "./rag.js";

/** A model reranker's model as the cascade resolves it, and the provider that serves it. */
export interface ResolvedRerankerModel {
  readonly name: string;
  readonly model: string;
  readonly modelProvider?: string;
  /** Its `prompt` as assembly read it (#1347); `""` when it has none. */
  readonly prompt?: string;
}

/**
 * A model reranker's model: its own `model`, else its provider's default — the provider it names, else
 * its workflow's, else its application's. None of them has one → `[model.missing]`; no provider
 * anywhere and no `model` → `[model.missing-provider]`.
 */
function rerankerModelOf(
  cls: Class,
  meta: { readonly name: string; readonly model?: string; readonly modelProvider?: Class },
  cascade: ModelCascade,
): ResolvedRerankerModel | RuleViolation {
  const level = meta.modelProvider ?? cascade.workflow ?? cascade.application;
  const options =
    level !== undefined && isModelProviderClass(level) ? modelProviderOf(level) : undefined;
  if (options === undefined) {
    if (meta.model !== undefined) return { name: meta.name, model: meta.model };
    return violation(
      "model.missing-provider",
      `${meta.name}: a model reranker names no model and no @ModelProvider serves it — set modelProvider on it, its workflow or its application, or model on it (${cls.name})`,
      [meta.name],
    );
  }
  const model = modelNamedBy(options, meta.model);
  if (model === undefined)
    return violation(
      "model.missing",
      `${meta.name}: names no model and ${options.name} has no model or models.default — set model on the reranker or on the provider`,
      [meta.name],
    );
  return { name: meta.name, model, modelProvider: options.name };
}

/** The model rerankers' models of knowledge bases, once each, resolved through the cascade. */
export function rerankerModelsOf(
  rags: readonly Class[],
  cascade: ModelCascade = {},
  prompts: ReadonlyMap<string, string> = new Map(),
): readonly ResolvedRerankerModel[] {
  const found = new Map<string, ResolvedRerankerModel | RuleViolation>();
  for (const rag of rags) {
    const reranked = rerankedBy(ragMeta(rag));
    if (reranked === undefined || isCodeRerankerClass(reranked.cls)) continue;
    if (!found.has(reranked.meta.name))
      found.set(reranked.meta.name, rerankerModelOf(reranked.cls, reranked.meta, cascade));
  }
  const all = [...found.values()];
  const violations = all.filter((one): one is RuleViolation => "code" in one);
  if (violations.length > 0) throw new GraphRuleError({ violations });
  return all
    .filter((one): one is ResolvedRerankerModel => !("code" in one))
    .map((one) => {
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
    const resolved = rerankerModelOf(cls, reranker, cascade);
    if ("code" in resolved) throw new GraphRuleError({ violations: [resolved] });
    if (services.rerankModel === undefined)
      throw new ComponentError({
        message: `[reranker.no-model-gateway] ${reranker.name}: no model gateway here`,
      });
    return services.rerankModel(reranker.name, resolved.model, resolved.modelProvider);
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
