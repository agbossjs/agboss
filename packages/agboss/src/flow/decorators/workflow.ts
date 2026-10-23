import { callerFile } from "../../components/call-site.js";
import type { Class, Provider } from "../../components/injection.js";
import type { AgentMeta } from "../../components/meta-types.js";
import type { UncompactedTurns } from "../../compaction/compaction.decorator.js";
import type { Reasoning } from "../../models/reasoning.js";
import type { Bytes } from "../../units/index.js";
import { NodeKind, type FlowPath } from "../ast.js";
import type { ThisWorkflowCheck } from "../this-workflow-types.js";
import { declarationOf, declared, recordDeclaration } from "./declaration.js";

/** Defaults of every chat model (agents, model routers): no `thinking` strings (#269). */
export interface ModelDefaults {
  readonly temperature?: number;
  readonly maxTokens?: AgentMeta["maxTokens"];
  readonly reasoning?: Reasoning;
  readonly cache?: AgentMeta["cache"];
}

/** The model of routers without their own `model` (#261: `defaults.router` keeps only `model`). */
export interface RouterDefaults {
  readonly model: string;
}

/**
 * The model of guardrails without their own `model` (#261, #120) — separate from
 * `defaults.router`: a guardrail never takes the router's model, and the framework has none built in.
 */
export interface GuardrailDefaults {
  readonly model: string;
}

export interface ToolDefaults {
  readonly maxToolCalls?: number;
  /**
   * What a model reads of one tool result at most, in bytes of UTF-8 (#336): `kilobytes(64)`;
   * a tool's own `maxResultSize` wins; nothing set → 128 KB.
   */
  readonly maxResultSize?: Bytes;
}

/** Flow checks: a path nesting more levels warns `[flow.path-too-deep]` (default 4). */
export interface FlowDefaults {
  readonly maxPathDepth?: number;
}

/**
 * Defaults of every component of a workflow — set on `@Application` (all workflows) and on
 * `@Workflow` (its own), merged field by field; the most specific level that sets a field wins.
 */
export interface WorkflowDefaults {
  readonly models?: ModelDefaults;
  readonly router?: RouterDefaults;
  readonly guardrail?: GuardrailDefaults;
  readonly tools?: ToolDefaults;
  readonly flow?: FlowDefaults;
}

/**
 * `@Workflow` — the graph as paths (`flow`), the workflow's count limits and its module: services,
 * MCP servers, channels, PII policies, guardrails and memory; observers are the application's (`@Application({
 * observers })`, #261).
 */
export interface WorkflowOptions<
  TName extends string = string,
  TFlow extends readonly FlowPath[] = readonly FlowPath[],
> {
  /** Ends with `-workflow` (`offer-workflow`); keys its `ThisWorkflowOutputs` entry (#264). */
  readonly name: TName;
  readonly version: string;
  /** The paths; what they claim of `ThisWorkflow` is checked against this workflow's own entry. */
  readonly flow: TFlow;
  /** Steps (agent and router visits) per execution; default (agents + routers) × 3 (#261). */
  readonly maxSteps?: number;
  /** Nesting of child workflows (#263, #264). */
  readonly maxDepth?: number;
  /**
   * How many executions of the tree — the root and all its descendants — work on a step at once
   * (#264); default 10. The rest wait in a queue (a throttle, never an error); one waiting at a
   * join or paused holds no slot. A child's own smaller value limits its subtree.
   */
  readonly maxConcurrentExecutions?: number;
  readonly defaults?: WorkflowDefaults;
  /** The workflow's own services for DI: classes, or values bound with `provide(TOKEN, value)`. */
  readonly providers?: readonly Provider[];
  /** `@McpServer` classes its `@McpTool`s call. */
  readonly mcp?: readonly Class[];
  /** `@PiiPolicy` classes of every agent and router, over the application's (#120: lists add up). */
  readonly piiPolicies?: readonly Class[];
  /**
   * `@InputGuardrail` / `@OutputGuardrail` classes of every agent and model router, over the
   * application's (#120: lists add up; `excludeGuardrails` on an agent or a router removes one).
   */
  readonly guardrails?: readonly Class[];
  /**
   * `@ToolInterceptor` classes of every agent's tool calls, over the application's (#384: lists add
   * up; `excludeToolInterceptors` on an agent or a tool removes one).
   */
  readonly toolInterceptors?: readonly Class[];
  /**
   * The `@Compaction` of every agent and model router, over the application's (#120: one setting,
   * the lowest level that sets it wins; none anywhere → no summaries, the window only).
   */
  readonly compaction?: Class;
  /**
   * How many recent turns of the thread its agents and model routers see in full, over the
   * application's (#120; default 5, `TurnLimit.ALL` = every turn); an agent's or a router's own wins.
   */
  readonly uncompactedTurns?: UncompactedTurns;
  /** Static `{{key}}` values of every prompt of the workflow. */
  readonly promptVariables?: Readonly<Record<string, string>>;
}

/** The flow is recorded as plain data: each path's source and steps, never the builder objects. */
const plainPath = (path: FlowPath): FlowPath => ({ source: path.source, steps: path.steps });

export function Workflow<const TName extends string, const TFlow extends readonly FlowPath[]>(
  options: WorkflowOptions<TName, TFlow> & ThisWorkflowCheck<TName, TFlow>,
): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  const recorded: WorkflowOptions = { ...options, flow: options.flow.map(plainPath) };
  return <TClass extends Class>(value: TClass): TClass => {
    recordDeclaration(value, declared(NodeKind.Workflow, recorded, source));
    return value;
  };
}

/**
 * `@Workflow({ maxConcurrentExecutions })` (#264): how many executions of a tree work at once — the
 * root's value caps the whole tree, a child's own smaller value its subtree. Read from the
 * declaration by the rules, `describe` and the runtime alike.
 */

/** `maxConcurrentExecutions` of a workflow that sets none. */
export const DEFAULT_MAX_CONCURRENT_EXECUTIONS = 10;

/** `@Workflow({ maxConcurrentExecutions })` as the workflow declares it; `undefined` when unset. */
export function declaredMaxConcurrentExecutionsOf(workflow: Class): number | undefined {
  const declaration = declarationOf(workflow);
  return declaration?.kind === NodeKind.Workflow
    ? declaration.options.maxConcurrentExecutions
    : undefined;
}

/** A workflow's cap: its own, else the default 10. */
export const maxConcurrentExecutionsOf = (workflow: Class): number =>
  declaredMaxConcurrentExecutionsOf(workflow) ?? DEFAULT_MAX_CONCURRENT_EXECUTIONS;
