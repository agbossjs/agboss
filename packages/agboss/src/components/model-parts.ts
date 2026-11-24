import { hasFileStore, ownFileRedactorOf, ownFileTranscriberOf } from "../files/assemble-files.js";
import { modelArbitersOf } from "../flow/runtime/launch/runtime-launch.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { LoadedGuardrail } from "../guardrails/assembly.js";
import { resolvedModelProvidersOf, type WorkflowModels } from "../models/resolution.js";
import type { AssembledPii } from "../pii/assembly.js";
import type { AssembledWorkflow } from "../workflow.js";
import type { AgentsConfigOf } from "../config/types.js";
import {
  referencedModelProvidersOf,
  withModelProviders,
  type ModelCascade,
} from "../models/model-cascade.js";
import type { Class, Provider } from "./injection.js";
import { rerankerModelsOf } from "./rag.js";
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
  readonly rerankers: readonly { readonly name: string; readonly model: string }[];
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
  const arbiters = modelArbitersOf(graph.launches);
  const { replyInterpreters, rerankers } = users;
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

/** The levels a workflow's model providers come from: itself, its application and its agents (#1313). */
export const modelCascadeOf = (
  bundle: Pick<WorkflowMeta, "modelCascade">,
  agents: readonly AgentMeta[],
): ModelCascade => ({
  ...bundle.modelCascade,
  components: agents.map((agent) => agent.modelProvider),
});

/** What a workflow's models are read from, and the policies' and channels' own. */
interface WorkflowModelParts {
  readonly owner:
    { readonly providers?: readonly Provider[]; readonly modelProvider?: Class } | undefined;
  readonly bundle: Pick<WorkflowMeta, "modelCascade">;
  readonly agents: readonly AgentMeta[];
  readonly config: WorkflowModels["config"];
  readonly routers: WorkflowModels["routers"];
  readonly graph: RuntimeGraph;
}

/** The workflow's model parts: its policies', interpreters' and rerankers' models resolved with its cascade (#1313). */
export const workflowModelPartsOf = (
  parts: WorkflowModelParts,
  users: Omit<ModelUsers, "rerankers"> & { readonly rags: Parameters<typeof rerankerModelsOf>[0] },
): ReturnType<typeof modelPartsOf> => {
  const { owner, bundle, agents, config, routers, graph } = parts;
  const { rags, ...rest } = users;
  const cascade = modelCascadeOf(bundle, agents);
  return modelPartsOf(
    owner,
    { config, routers },
    graph,
    { ...rest, rerankers: rerankerModelsOf(rags) },
    cascade,
  );
};

/** The config with every model resolved through its cascade (#1313). */
export const cascadedConfigOf = (
  config: AgentsConfigOf<string>,
  bundle: Pick<WorkflowMeta, "modelCascade">,
  agents: readonly AgentMeta[],
): AgentsConfigOf<string> => withModelProviders(config, modelCascadeOf(bundle, agents));
