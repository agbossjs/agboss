import type { Class } from "../../../components/injection.js";
import { isCodeJudge } from "../../../components/judge-decorators.js";
import { componentOf } from "../../../components/metadata.js";
import { modelNamedBy } from "../../../models/model-cascade.js";
import {
  isDriverOptions,
  isModelProviderClass,
  modelProviderOf,
  type KeptModelProviderOptions,
} from "../../../models/model-provider.decorator.js";
import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import { NodeKind } from "../../ast.js";
import type { FlowGraph } from "../flow-graph.js";
import type { AnalysisContext } from "./context.js";

/**
 * A model judge of the same model family as what it judges grades its own family's answers too
 * kindly (self-preference) — the warning `[judge.same-model-family]`, an error under `--strict`
 * (#396 S2 Q9). The family is the slug's vendor prefix (`openai` of `openai/gpt-6`); a model id
 * without one has no family and is never compared. An agent's judges are read against that agent's
 * model; a suite's judges against every agent of the workflow its start opens. A code judge has no
 * model.
 */

/** The slash-less model ids a vendor names its models with (`gpt-6`, `claude-sonnet-5`), by family. */
const BARE_FAMILIES: readonly (readonly [string, RegExp])[] = [
  ["openai", /^(gpt-|o1|o3|o4|chatgpt-)/u],
  ["anthropic", /^claude-/u],
  ["google", /^gemini-/u],
  ["deepseek", /^deepseek/u],
  ["qwen", /^qwen/u],
  ["meta-llama", /^llama/u],
  ["mistralai", /^(mistral|codestral)/u],
  ["x-ai", /^grok-/u],
];

/**
 * `openai` of `openai/gpt-6`, or of a slash-less `gpt-6`; undefined for an id whose vendor is not
 * known. (An id such as `meta-llama/llama-4` and a bare `llama-4` are one family.)
 */
export function modelFamilyOf(model: string): string | undefined {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const vendor = model.slice(0, slash);
    return BARE_FAMILIES.find(([, pattern]) => pattern.test(vendor))?.[0] ?? vendor;
  }
  const bare = model.toLowerCase();
  return BARE_FAMILIES.find(([, pattern]) => pattern.test(bare))?.[0];
}

/** An agent a judge reads the answers of: its name, its model, and the provider that serves it. */
export interface JudgedAgent {
  readonly name: string;
  /** None: the agent's provider names it (#1313); the family is not known before assembly. */
  readonly model: string | undefined;
  /** The agent's own `@ModelProvider`, when it names one. */
  readonly modelProvider?: Class | undefined;
}

/** A model as it is served: the vendor's name (aliases of its provider resolved) and the endpoint. */
interface ServedModel {
  readonly model: string | undefined;
  readonly baseUrl: string | undefined;
}

/** Where a provider's calls go: its base URL, or its driver's (an `env(…)` reference by its variable). */
function endpointOf(options: KeptModelProviderOptions): string | undefined {
  if (!isDriverOptions(options)) return "baseUrl" in options ? options.baseUrl : undefined;
  const { baseUrl } = options.driver.settings;
  return typeof baseUrl === "string" ? baseUrl : `$${baseUrl.variable}`;
}

/** The model a component names, through its own provider's roles (`"fast"` → the vendor's name). */
function servedBy(model: string | undefined, provider: Class | undefined): ServedModel {
  if (provider === undefined || !isModelProviderClass(provider))
    return { model, baseUrl: undefined };
  const options = modelProviderOf(provider);
  return { model: modelNamedBy(options, model), baseUrl: endpointOf(options) };
}

/** Whether two served models are one family: the same vendor, or exactly the same endpoint and model. */
function sameFamily(first: ServedModel, second: ServedModel): string | undefined {
  if (first.model === undefined || second.model === undefined) return undefined;
  const family = modelFamilyOf(first.model);
  if (family !== undefined && family === modelFamilyOf(second.model)) return family;
  const sameEndpoint = first.baseUrl !== undefined && first.baseUrl === second.baseUrl;
  return sameEndpoint && first.model === second.model ? first.model : undefined;
}

/** The judge's own model, when it is a model judge, through its own provider's roles. */
function judgeModelOf(
  judge: Class,
): { readonly name: string; readonly served: ServedModel } | undefined {
  const found = componentOf(judge);
  if (found?.kind !== "judge" || isCodeJudge(found.meta)) return undefined;
  const { model, modelProvider } = found.meta;
  // no model and no provider named: the provider's role, whose vendor is not known before assembly
  if (model === undefined && modelProvider === undefined) return undefined;
  return { name: found.meta.name, served: servedBy(model, modelProvider) };
}

/** The warning of one judge against the agents it judges, when one shares its model's family. */
export function sameFamilyWarnings(
  judge: Class,
  agents: readonly JudgedAgent[],
  where: string,
): RuleViolation[] {
  const own = judgeModelOf(judge);
  if (own?.served.model === undefined) return [];
  const ownModel = own.served.model;
  return agents.flatMap((agent) => {
    const served = servedBy(agent.model, agent.modelProvider);
    const family = sameFamily(own.served, served);
    if (family === undefined || served.model === undefined) return [];
    const message =
      `${where}${own.name} (${ownModel}) judges ${agent.name}, whose model ${served.model} is of ` +
      `the same family (${family}) — a judge grades its own family's answers too kindly: give ` +
      "the judge a model of another vendor";
    return [violation("judge.same-model-family", message, [own.name, agent.name])];
  });
}

/** Every agent of a walked workflow, with its model. */
export function agentsOf(graph: FlowGraph): JudgedAgent[] {
  return [...graph.nodes.values()].flatMap((node) =>
    node.declaration.kind === NodeKind.Agent
      ? [
          {
            name: node.name,
            model: node.declaration.options.model,
            modelProvider: node.declaration.options.modelProvider,
          },
        ]
      : [],
  );
}

/** The workflow's agents' own judges, each against the agent it judges. */
export function judgeFamilyWarnings(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Agent) return [];
    const agent = {
      name: node.name,
      model: declaration.options.model,
      modelProvider: declaration.options.modelProvider,
    };
    return (declaration.options.judges ?? []).flatMap((judge) =>
      sameFamilyWarnings(judge, [agent], ""),
    );
  });
}

/**
 * `[judge.zero-retries]` (#1290): an agent with `judges` and no retries. A rejected answer then fails
 * the run at once — the judge's reason never reaches the model for a second try: set `executionLimits.maxRetries`.
 */
export function judgeRetryWarnings(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.graph.nodes.values()].flatMap((node) => {
    const { declaration } = node;
    if (declaration.kind !== NodeKind.Agent) return [];
    const { judges, executionLimits } = declaration.options;
    const maxRetries = executionLimits?.maxRetries;
    if ((judges ?? []).length === 0 || (maxRetries ?? 0) > 0) return [];
    const message = `${node.name}: has judges but no retries (executionLimits.maxRetries is ${maxRetries === undefined ? "not set" : "0"}) — a rejected answer fails the run, and the judge's reason never reaches the model: set executionLimits.maxRetries to give it another try`;
    return [violation("judge.zero-retries", message, [node.name])];
  });
}
