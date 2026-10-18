import type { ObserverManager } from "../core/observer-manager.js";
import type { AgentPrompts, AgentsConfigOf } from "../config/types.js";
import type { GuardSet } from "../guards/index.js";
import type { ModelRegistry } from "../llm/registry.js";
import type { BaseMemoryStrategy } from "../memory/types.js";
import type { PauseSeam } from "../pause/index.js";
import type { KnowledgeSource } from "../rag/types.js";
import type { RouterEngine } from "../routers/index.js";
import type { AnyTool } from "../tools/index.js";
import type { RuntimeGraph } from "../flow/runtime/graph-model.js";
import type { LoadedRouter } from "../flow/runtime/routers.js";
import type { LaunchDecider } from "../flow/runtime/launch/launch-decider.js";
import type {
  ChannelRequest,
  Guardrail,
  InboundChannelAdapter,
  PiiPolicy,
} from "../components/decorators.js";
import type { Class } from "../components/injection.js";
import type { ResolvedPolicies } from "../workflow.js";
import type { WorkflowLimits } from "./settings.js";
import type { JudgeHandler } from "../components/judge-decorators.js";

/** What the workflow's graph is built from: its analysed paths, its agents and their parts. */
export interface GraphDeps<TName extends string> {
  readonly config: AgentsConfigOf<TName>;
  readonly registry: ModelRegistry;
  /** Each agent's instructions (static, #270 Q51). */
  readonly prompts: AgentPrompts<TName>;
  /** Resolves a tool name from an agent's config to the tool. */
  readonly tools: (name: string) => AnyTool;
  readonly guards: GuardSet;
  /** Agents' own memory strategies (`@Agent({ memoryStrategy })`); the rest use the built-in one. */
  readonly memory?: ReadonlyMap<string, BaseMemoryStrategy>;
  /** The agents' `@Judge`s by judge name, created by the container (models in `registry.judges`). */
  readonly judges?: ReadonlyMap<string, JudgeHandler>;
  /** Context-mode knowledge bases per agent (knowledge bases, #88). */
  readonly knowledge?: (agent: string) => readonly KnowledgeSource[];
  /** Optional pause seam (approval of tool calls). Off by default. */
  readonly pause?: PauseSeam | undefined;
  /** Dispatches an approval request to the specified channel. */
  readonly requestApproval?: (channelName: string, req: ChannelRequest) => Promise<void>;
  readonly piiPolicies?: (agent: string) => ResolvedPolicies<PiiPolicy>;
  readonly toolPiiPolicies?: (tool: string) => ResolvedPolicies<PiiPolicy>;
  readonly toolGuardrails?: (tool: string) => ResolvedPolicies<Guardrail>;
  readonly workflowPiiPolicies?: readonly PiiPolicy[];
  readonly workflowGuardrails?: readonly Guardrail[];
  readonly guardrails?: (agent: string) => ResolvedPolicies<Guardrail>;
  /** The inbound adapter of a channel: reads the reply a run is resumed with. */
  readonly channelAdapters?: (channel: string) => InboundChannelAdapter | undefined;
  /** The workflow's graph: its paths, analysed (`@Workflow({ flow })`). */
  readonly graph: RuntimeGraph;
  /** From the workflow's `settings()`. */
  readonly limits: WorkflowLimits;
  /** Steps per execution (`@Workflow({ maxSteps })`, default (agents + routers) × 3). */
  readonly maxSteps: number;
  /** Every router of the graph with its texts loaded (part of the run's versions). */
  readonly routers: readonly LoadedRouter[];
  /** The decision engine of a router: its own model (Jev or a chat model). */
  readonly routerFor: (router: LoadedRouter) => RouterEngine;
  /** A model router's decisions before a parallel launch (#273 S23): its `OnDemand` routes. */
  readonly launchDecisionFor?: (router: LoadedRouter) => LaunchDecider;
  readonly observer?: ObserverManager;
  /** A component instance from the app's container: actions and finishes with a handler. */
  readonly container: { readonly get: <T>(token: Class<T>) => T };
}
