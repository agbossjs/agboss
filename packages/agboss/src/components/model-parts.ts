import { hasFileStore, ownFileRedactorOf, ownFileTranscriberOf } from "../files/assemble-files.js";
import { modelArbitersOf, type ModelArbiterUse } from "../flow/runtime/launch/runtime-launch.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { LoadedGuardrail } from "../guardrails/assembly.js";
import { resolvedModelProvidersOf, type WorkflowModels } from "../models/resolution.js";
import { GraphRuleError } from "../graph/rule-error.js";
import { providerRuleViolations } from "../models/provider-mode-rules.js";
import type { AssembledPii } from "../pii/assembly.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { AgentsConfigOf } from "../config/types.js";
import { referencedModelProvidersOf, type ModelCascade } from "../models/model-cascade.js";
import { withModelProviders } from "../models/config-cascade.js";
import { modelResolverOf, type ModelResolver } from "../models/model-resolver.js";
import type { WorkflowDefaults, WorkflowOptions } from "../flow/decorators/workflow.js";
import type { Class, Provider } from "./injection.js";
import { componentOf } from "./metadata.js";
import { rerankerModelsOf } from "./rag-reranker.js";
import type { AgentMeta, WorkflowMeta } from "./meta-types.js";
import type { AssembledReplyInterpreter } from "../channels/discovery.js";

/** The models of a workflow's policies: PII detections (#120) and guardrails (#120 PR 2). */
export interface PolicyModels {
  readonly pii: AssembledPii["detectors"];
  readonly guardrails: readonly LoadedGuardrail[];
}

/** The model-calling components besides config and routers: policies and reply interpreters. */
export interface ModelUsers extends PolicyModels {
  readonly replyInterpreters: readonly AssembledReplyInterpreter[];
  /** The knowledge bases' model rerankers (#703). */
  readonly rerankers: readonly {
    readonly name: string;
    readonly model: string;
    readonly modelProvider?: string;
    readonly unpriced?: true;
  }[];
  /** The model arbiters with their models resolved (#1313); none given: as declared. */
  readonly arbiters?: readonly ModelArbiterUse[];
}

/**
 * The workflow's model arbiters (#279), its reply interpreters (#267) and its model providers,
 * every model resolved to one — its policies' models (#120) too.
 */
export function modelPartsOf(
  owner: { readonly providers?: readonly Provider[] } | undefined,
  models: Pick<WorkflowModels, "config" | "routers">,
  graph: RuntimeGraph,
  users: ModelUsers,
  cascade: ModelCascade = {},
): Pick<
  AssembledWorkflow,
  | "arbiters"
  | "modelProviders"
  | "replyInterpreters"
  | "rerankers"
  | "ownFileTranscriber"
  | "ownFileRedactor"
  | "hasFileStore"
> {
  const arbiters = users.arbiters ?? modelArbitersOf(graph.launches);
  const { replyInterpreters, rerankers } = users;
  // a provider only a workflow or a component names is checked like a listed one (#1313)
  const named = providerRuleViolations(models.config.name, referencedModelProvidersOf(cascade));
  if (named.length > 0) throw new GraphRuleError({ violations: named });
  return {
    arbiters,
    // the application lists its own `FileTranscriber` (#899): the built-in's model is no use then
    ownFileTranscriber: ownFileTranscriberOf(owner?.providers),
    ownFileRedactor: ownFileRedactorOf(owner?.providers),
    hasFileStore: hasFileStore(owner?.providers),
    replyInterpreters,
    rerankers,
    modelProviders: resolvedModelProvidersOf(
      owner?.providers,
      {
        ...models,
        arbiters,
        pii: { detectors: users.pii },
        guardrails: { guardrails: users.guardrails },
        replyInterpreters,
        rerankers,
      },
      referencedModelProvidersOf(cascade),
    ),
  };
}

/** The `modelProvider` each judge of the agents names itself (#1290). */
const judgeProvidersOf = (agents: readonly AgentMeta[]): readonly (Class | undefined)[] =>
  agents.flatMap((agent) =>
    (agent.judges ?? []).map((cls) => {
      const component = componentOf(cls);
      return component?.kind === "judge" ? component.meta.modelProvider : undefined;
    }),
  );

/** The levels a workflow's model providers come from: itself, its application, its agents and judges (#1313). */
export const modelCascadeOf = (
  bundle: Pick<WorkflowMeta, "modelCascade">,
  agents: readonly AgentMeta[],
): ModelCascade => ({
  ...bundle.modelCascade,
  components: [...agents.map((agent) => agent.modelProvider), ...judgeProvidersOf(agents)],
});

/** The levels over a component's own provider: the workflow's and its application's, with their default models (#1313). */
export const levelCascadeOf = (
  options: Pick<WorkflowOptions, "modelProvider" | "defaults">,
  owner: { readonly modelProvider?: Class; readonly defaults?: WorkflowDefaults } | undefined,
): ModelCascade => ({
  workflow: options.modelProvider,
  application: owner?.modelProvider,
  models: {
    workflow: options.defaults?.models?.model,
    application: owner?.defaults?.models?.model,
  },
});

/** The resolver of a workflow's model cascade: its levels and the providers its agents name. */
export const resolverOf = (
  bundle: Pick<WorkflowMeta, "name" | "modelCascade">,
  agents: readonly AgentMeta[],
): ModelResolver => modelResolverOf(bundle.name, modelCascadeOf(bundle, agents));

/** What a workflow's models are read from, and the policies' and channels' own. */
interface WorkflowModelParts {
  readonly owner:
    { readonly providers?: readonly Provider[]; readonly modelProvider?: Class } | undefined;
  readonly bundle: Pick<WorkflowMeta, "modelCascade">;
  readonly agents: readonly AgentMeta[];
  readonly config: WorkflowModels["config"];
  readonly routers: WorkflowModels["routers"];
  readonly graph: RuntimeGraph;
  /** Resolved every model of the workflow through its cascade so far (#1313). */
  readonly resolver: ModelResolver;
}

/** The workflow's model parts: its policies', interpreters' and rerankers' models resolved with its cascade (#1313). */
export const workflowModelPartsOf = (
  parts: WorkflowModelParts,
  users: Omit<ModelUsers, "rerankers"> & { readonly rags: Parameters<typeof rerankerModelsOf>[0] },
): ReturnType<typeof modelPartsOf> => {
  const { owner, bundle, agents, config, routers, graph, resolver } = parts;
  const { rags, ...rest } = users;
  // every model through its cascade; a model that resolves to nothing fails the assembly here
  const arbiters = modelArbitersOf(graph.launches, resolver);
  resolver.check();
  const base = modelCascadeOf(bundle, agents);
  // the providers the components named and the cascade's own are all subject to the provider rules
  const cascade = { ...base, components: [...(base.components ?? []), ...resolver.providers()] };
  return modelPartsOf(
    owner,
    { config, routers },
    graph,
    { ...rest, rerankers: rerankerModelsOf(rags, bundle.modelCascade ?? {}), arbiters },
    cascade,
  );
};

/** The config with every model resolved through its cascade (#1313). */
export const cascadedConfigOf = (
  config: AgentsConfigOf<string>,
  bundle: Pick<WorkflowMeta, "modelCascade">,
  agents: readonly AgentMeta[],
  resolver: ModelResolver,
): AgentsConfigOf<string> => withModelProviders(config, modelCascadeOf(bundle, agents), resolver);
