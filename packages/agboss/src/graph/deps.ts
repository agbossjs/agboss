import type { ExecutionObserverManager } from "../core/observer-manager.js";
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
import type { ArbiterModel } from "../flow/runtime/launch/arbiter-model.js";
import type { BranchErrors } from "../flow/runtime/launch/branch-end.js";
import type { BranchScheduler } from "../flow/runtime/launch/branch-schedule.js";
import type { ArbiterClass } from "../flow/ast.js";
import type { Guardrail } from "../components/decorators.js";
import type { PauseChannel } from "../flow/runtime/pause.js";
import type { PiiRuntime } from "../pii/runtime.js";
import type { Class } from "../components/injection.js";
import type { ResolvedPolicies } from "../workflow.js";
import type { JudgeHandler } from "../components/judge-decorators.js";
import type { RuntimeContexts } from "../flow/context/runtime-contexts.js";

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
  readonly judges?: ReadonlyMap<string, JudgeHandler<unknown>>;
  /** Context-mode knowledge bases per agent (knowledge bases, #88). */
  readonly knowledge?: (agent: string) => readonly KnowledgeSource[];
  /** Optional pause seam (approval of tool calls). Off by default. */
  readonly pause?: PauseSeam | undefined;
  /** The errors of failed launch branches across this process's passes (#267 AC10). */
  readonly branchErrors?: BranchErrors;
  /** A test's schedule of launch branches (#262 S33, `TestConcurrency`); absent in production. */
  readonly branchScheduler?: BranchScheduler;
  /** The channel a tool names, by its name (#267): created with the app. */
  readonly channelOf?: (channelName: string) => PauseChannel;
  /** The PII policies at each agent's and router's model (#120); absent = none. */
  readonly pii?: PiiRuntime;
  readonly toolGuardrails?: (tool: string) => ResolvedPolicies<Guardrail>;
  readonly workflowGuardrails?: readonly Guardrail[];
  readonly guardrails?: (agent: string) => ResolvedPolicies<Guardrail>;
  /** The workflow's graph: its paths, analysed (`@Workflow({ flow })`). */
  readonly graph: RuntimeGraph;
  /** Steps per execution (`@Workflow({ maxSteps })`, default (agents + routers) × 3). */
  readonly maxSteps: number;
  /** Every router of the graph with its texts loaded (part of the run's versions). */
  readonly routers: readonly LoadedRouter[];
  /** The decision engine of a router: its own model (Jev or a chat model). */
  readonly routerFor: (router: LoadedRouter) => RouterEngine;
  /** A model router's decisions before a parallel launch (#273 S23): its `OnDemand` routes. */
  readonly launchDecisionFor?: (router: LoadedRouter) => LaunchDecider;
  /** A model arbiter's model (#279): one yes/no decision per answer; none for a code arbiter. */
  readonly arbiterModelFor?: (arbiter: ArbiterClass) => ArbiterModel | undefined;
  readonly observer?: ExecutionObserverManager;
  /**
   * The application's context levels (#261, framework wiring: `RuntimeContexts` is internal,
   * `agboss/internal`); absent = a workflow run on its own (eval, replay).
   */
  readonly contexts?: RuntimeContexts;
  /**
   * The run dependencies of a child workflow of the graph (#263): every workflow of the
   * application, children included, is built once; `undefined` for a workflow run on its own.
   */
  readonly childDepsOf?: (workflow: Class) => GraphDeps<string> | undefined;
  /** A component instance from the app's container: actions and finishes with a handler. */
  readonly container: { readonly get: <T>(token: Class<T>) => T };
}
