import { memoryPlanOf, readerOf } from "../compaction/plan.js";
import type { UncompactedTurns } from "../compaction/compaction.decorator.js";
import { promptTextOf } from "../components/prompt-render.js";
import { DEFAULT_MAX_TOKENS } from "../config/types.js";
import type { RagMode } from "../rag/types.js";
import { NodeKind } from "../flow/ast.js";
import {
  DecidedBy,
  failurePolicyOf,
  isCodeRouter,
  routesOf,
  spawnPolicyOf,
  type FailurePolicy,
  type SpawnPolicy,
} from "../flow/decorators/router.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { RuntimeNode } from "../flow/runtime/graph-model.js";
import {
  componentIoOf,
  describedIoOf,
  nodeRecordOf,
  type DescribedShape,
} from "../flow/runtime/join-keys.js";
import type { ComponentKind } from "../flow/runtime/records.js";
import { resolveAgentLimits } from "../graph/agent-loop/index.js";
import { reasoningLabel, reasoningOfThinking } from "../models/reasoning.js";
import { resolvedModelUsesOf } from "../models/resolution.js";
import { piiPolicyMetaOf } from "../pii/policy-checks.js";
import type { AssembledWorkflow } from "../workflow.js";
import { defaultMaxResultSizeOf } from "../tools/index.js";
import { actionSnapshotOf, type ActionSnapshot } from "./compensation.js";

/** One agent's settings in the assembled config. */
type AgentSettings = AssembledWorkflow["config"]["agents"][string];

/**
 * Every node of a workflow as data (#268 S92 / S93, `agboss describe --json`): its name, kind, join
 * keys (`promptHash`, `schemaHash`), what it reads and writes, and — an agent's internals — its
 * model and provider, reasoning, limits, memory, tools, knowledge bases, the guardrails and PII
 * policies in effect after the application → workflow → agent cascade, its judges and its
 * instructions; a router's `decidedBy`, model, instructions and routes with their policies; an
 * action's `compensateWith` / `committedBy` (#339).
 */

/** The guardrails in effect at one agent or model router, by side. */
export interface ElementGuardrailsSnapshot {
  readonly input: readonly string[];
  readonly output: readonly string[];
}

/** One knowledge base of an agent. */
export interface RagSnapshot {
  readonly name: string;
  readonly mode: RagMode;
  readonly topK: number;
}

/** An agent's internals. */
export interface AgentSnapshot {
  readonly model: string;
  /** The model provider its model resolves to (#266). */
  readonly provider: string;
  readonly reasoning: string;
  readonly maxTokens: number | "max";
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  /** What its model reads of one tool result (a tool without its own) and knowledge block, in bytes (#336). */
  readonly maxResultSize: number;
  readonly uncompactedTurns: UncompactedTurns;
  readonly compaction?: string;
  readonly tools: readonly string[];
  readonly rag: readonly RagSnapshot[];
  readonly guardrails: ElementGuardrailsSnapshot;
  readonly piiPolicies: readonly string[];
  readonly judges: readonly string[];
  readonly maxRetries: number;
  /** The instructions its model reads, as rendered (what `promptHash` hashes). */
  readonly instructions: string;
}

/** One route of a router. */
export interface RouteSnapshot {
  readonly target: string;
  readonly prompt?: string;
  readonly spawn: SpawnPolicy;
  readonly failure: FailurePolicy;
}

/** A router's internals. */
export interface RouterSnapshot {
  readonly decidedBy: DecidedBy;
  readonly model?: string;
  readonly provider?: string;
  readonly instructions?: string;
  readonly guardrails?: ElementGuardrailsSnapshot;
  readonly piiPolicies?: readonly string[];
  readonly routes: readonly RouteSnapshot[];
}

/** One node of the flow. */
export interface NodeSnapshot {
  readonly name: string;
  readonly kind: ComponentKind;
  readonly description?: string;
  readonly promptHash: string | undefined;
  readonly schemaHash: string | undefined;
  readonly input?: DescribedShape;
  readonly output?: DescribedShape;
  readonly maxVisits?: number;
  readonly agent?: AgentSnapshot;
  readonly router?: RouterSnapshot;
  /** An action's `compensateWith` / `committedBy` (#339). */
  readonly action?: ActionSnapshot;
}

/** Who serves each model of the workflow, by its use's key (`agents.<name>`, `routers.<name>`). */
const providersOf = (bundle: AssembledWorkflow): ReadonlyMap<string, string> =>
  new Map(resolvedModelUsesOf(bundle).map((use) => [use.key, use.provider]));

function guardrailsAt(bundle: AssembledWorkflow, element: string): ElementGuardrailsSnapshot {
  const sides = bundle.guardrails?.byElement.get(element);
  return {
    input: (sides?.input ?? []).map((guardrail) => guardrail.name),
    output: (sides?.output ?? []).map((guardrail) => guardrail.name),
  };
}

const piiPoliciesAt = (bundle: AssembledWorkflow, element: string): readonly string[] =>
  (bundle.pii?.byElement.get(element) ?? []).map((cls) => piiPolicyMetaOf(cls)?.name ?? cls.name);

/** An agent's model settings: its model and provider, reasoning, output ceiling and limits. */
function modelSettingsOf(
  bundle: AssembledWorkflow,
  name: string,
  agent: AgentSettings,
  providers: ReadonlyMap<string, string>,
) {
  const { defaults } = bundle.config;
  const { limits } = resolveAgentLimits(agent.maxToolCalls, defaults.tools?.maxToolCalls);
  const thinking = agent.thinking ?? defaults.models.thinking;
  return {
    model: agent.model,
    provider: providers.get(`agents.${name}`) ?? "",
    reasoning: thinking === undefined ? "provider" : reasoningLabel(reasoningOfThinking(thinking)),
    maxTokens: agent.maxTokens ?? defaults.models.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxModelCalls: limits.modelCalls,
    maxToolCalls: limits.toolCalls,
    maxResultSize: defaultMaxResultSizeOf(defaults.tools?.maxResultSize),
  };
}

function agentOf(
  bundle: AssembledWorkflow,
  name: string,
  providers: ReadonlyMap<string, string>,
): AgentSnapshot | undefined {
  const agent = bundle.config.agents[name];
  if (agent === undefined) return undefined;
  const reader = readerOf(memoryPlanOf(bundle.config, bundle.compactions), name);
  return {
    ...modelSettingsOf(bundle, name, agent, providers),
    uncompactedTurns: reader.window,
    ...(reader.compaction === undefined ? {} : { compaction: reader.compaction.name }),
    tools: agent.tools ?? [],
    rag: (agent.rag ?? []).map(({ name: rag, mode, topK }) => ({ name: rag, mode, topK })),
    guardrails: guardrailsAt(bundle, name),
    piiPolicies: piiPoliciesAt(bundle, name),
    judges: agent.judges ?? [],
    maxRetries: agent.maxRetries ?? 0,
    instructions: promptTextOf(Reflect.get(bundle.prompts, name)) ?? "",
  };
}

function routerOf(
  bundle: AssembledWorkflow,
  node: RuntimeNode,
  providers: ReadonlyMap<string, string>,
): RouterSnapshot | undefined {
  if (node.declaration.kind !== NodeKind.Router) return undefined;
  const { options } = node.declaration;
  const loaded = bundle.routers.find((router) => router.name === node.id);
  const routes = routesOf(options).map((route) => {
    const target = declarationOf(route.target)?.options.name ?? route.target.name;
    const prompt = loaded?.routes.find((loadedRoute) => loadedRoute.option === target)?.condition;
    return {
      target,
      ...(prompt === undefined ? {} : { prompt }),
      spawn: spawnPolicyOf(options, route),
      failure: failurePolicyOf(route),
    };
  });
  if (isCodeRouter(options) || loaded === undefined) return { decidedBy: DecidedBy.Code, routes };
  return {
    decidedBy: DecidedBy.Model,
    model: loaded.model,
    provider: providers.get(`routers.${node.id}`) ?? "",
    instructions: loaded.instructions,
    guardrails: guardrailsAt(bundle, node.id),
    piiPolicies: piiPoliciesAt(bundle, node.id),
    routes,
  };
}

const descriptionOf = (node: RuntimeNode): string | undefined =>
  "description" in node.declaration.options &&
  typeof node.declaration.options.description === "string"
    ? node.declaration.options.description
    : undefined;

/** Every node of the workflow, in the graph's order. */
export function nodesOf(bundle: AssembledWorkflow): readonly NodeSnapshot[] {
  const providers = providersOf(bundle);
  return [...bundle.graph.nodes.values()].map((node) => {
    const record = nodeRecordOf(node, bundle);
    const description = descriptionOf(node);
    const agent = node.kind === NodeKind.Agent ? agentOf(bundle, node.id, providers) : undefined;
    const router = routerOf(bundle, node, providers);
    const action = actionSnapshotOf(node);
    return {
      name: record.name,
      kind: record.kind,
      ...(description === undefined ? {} : { description }),
      promptHash: record.promptHash,
      schemaHash: record.schemaHash,
      ...describedIoOf(componentIoOf(node.declaration)),
      ...(node.maxVisits === undefined ? {} : { maxVisits: node.maxVisits }),
      ...(agent === undefined ? {} : { agent }),
      ...(router === undefined ? {} : { router }),
      ...(action === undefined ? {} : { action }),
    };
  });
}
