import { callerFile } from "../../components/call-site.js";
import type { Class, Provider, ServiceEntry } from "../../components/injection.js";
import type { CacheSetting, MaxTokens } from "../../config/settings-types.js";
import type { FileDefaults } from "../../files/model-files.js";
import type { Reasoning } from "../../models/reasoning.js";
import type { Bytes } from "../../units/index.js";
import { NodeKind, type FlowPath } from "../ast.js";
import { declarationOf, declared, recordDeclaration } from "./declaration.js";

/** Defaults of every chat model (agents, model routers): no `thinking` strings (#269). */
export interface ModelDefaults {
  /**
   * The model of every component that names none, a role its provider maps (`"fast"`) or a vendor
   * name (#1313). It applies only to components that resolve to the provider of the level it is set
   * on (`@Workflow({ modelProvider })`, else `@Application({ modelProvider })`).
   */
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: MaxTokens;
  readonly reasoning?: Reasoning;
  readonly cache?: CacheSetting;
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
  /** What an agent's `files` take where it sets nothing, and the built-in transcriber's model (#899). */
  readonly files?: FileDefaults;
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
  /** Ends with `-workflow` (`offer-workflow`); also the node a recursion (`toWorkflow(() => Self)`) shows in its graph. */
  readonly name: TName;
  readonly version: string;
  /** The paths; a workflow launches itself with `toWorkflow(() => ItsOwnClass)` (#1287). */
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
  /**
   * The `@Budget` class that caps this workflow's executions (#1318): an execution-scope budget is its
   * own (replacing the application's default one), a tenant or application budget counts beside the
   * application's. One `@Budget` class serves any number of workflows — they share its counter, which
   * is keyed by the budget's name, never by a workflow's. It need not be listed in
   * `@Application({ budgets })`.
   */
  readonly budget?: Class;
  /**
   * The `@ModelProvider` class this workflow's models are served from unless the component names
   * another; left out, its application's (#1313).
   */
  readonly modelProvider?: Class;
  /** The workflow's own services for DI: classes, or values bound with `provide(TOKEN, value)`. */
  readonly providers?: readonly Provider[];
  /**
   * The workflow's own services (#1324): `@Injectable`, `@McpServer` and `@A2AAgent` classes bound to
   * abstract ports with `injectAs`, and values bound with `provide(TOKEN, value)`. They resolve in a
   * container of this workflow alone — no sibling workflow sees them, and what depends on them is
   * created once for this workflow — and they bind a port over the application's own `services`.
   */
  readonly services?: readonly ServiceEntry[];
  /**
   * `@PiiPolicy` classes of every agent and router, over the application's (#120: lists add up). A
   * child workflow's are added to those of the workflows above it (#1150): a child is masked by its
   * application's, every ancestor's and its own lists — in its logs, traces, events and records, and
   * at its models.
   */
  readonly piiPolicies?: readonly Class[];
  /**
   * Inherited PII policies removed at this workflow's models (#1150): an application's policy, or one
   * a workflow that launches it lists. Its agents, routers, reply interpreters and compactions read
   * without them; its logs, traces, events and records stay masked by every inherited policy.
   * Excluding what is not inherited is `[pii.exclude-not-inherited]`.
   */
  readonly excludePiiPolicies?: readonly Class[];
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
   * Application-level `@ToolInterceptor` classes removed for every agent of this workflow (#1295).
   * Excluding one its application does not list is `[tool-interceptor.exclude-not-inherited]`.
   */
  readonly excludeToolInterceptors?: readonly Class[];
  /**
   * The `@Memory` of every agent and model router (#1303): its `ttl`, its window and its compaction;
   * an agent's or a router's own `memory` wins. Left out, the workflow is stateless across runs.
   */
  readonly memory?: Class;
  /** Static `{{key}}` values of every prompt of the workflow. */
  readonly promptVariables?: Readonly<Record<string, string>>;
}

/** The flow is recorded as plain data: each path's source and steps, never the builder objects. */
const plainPath = (path: FlowPath): FlowPath => ({ source: path.source, steps: path.steps });

export function Workflow<const TName extends string, const TFlow extends readonly FlowPath[]>(
  options: WorkflowOptions<TName, TFlow>,
): (value: Class) => void {
  const source = callerFile();
  const recorded: WorkflowOptions = { ...options, flow: options.flow.map(plainPath) };
  // returns nothing: a class's own type must not depend on its decorator, or `() => ItsOwnClass`
  // inside its own `flow` would be a circular reference (TS2506, TS7022; its brand is generated)
  return (value: Class): void => {
    recordDeclaration(value, declared(NodeKind.Workflow, recorded, source));
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
