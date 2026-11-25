import { recordOptionKeys } from "../../components/option-keys.js";
import { WORKFLOW_KEYS } from "../../components/decorator-options.js";
import type { PromptVariables } from "../../components/prompt-variables.js";
import { callerFile } from "../../components/call-site.js";
import { captureCallSite } from "../../core/diagnostics/source-span.js";
import type { Class, Provider, ServiceEntry } from "../../components/injection.js";
import type { CacheSetting, MaxTokens } from "../../config/settings-types.js";
import type { FileDefaults } from "../../files/model-files.js";
import type { Reasoning } from "../../models/reasoning.js";
import type { Bytes, Milliseconds, Ttl } from "../../units/index.js";
import { NodeKind, type FlowPath } from "../ast.js";
import type { ChildPlacement } from "../child-placement.js";
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
}

/** What `@Application({ defaults: { workflows } })` sets for the child workflows that set nothing (#1286). */
export interface ChildWorkflowDefaults {
  /** Where a child workflow runs unless its own `@Workflow({ placement })` says; `CurrentProcess` when absent. */
  readonly placement?: ChildPlacement;
}

/**
 * The defaults of `@Application`: those of every workflow, and `workflows` — the children's, which a
 * workflow never sets for another (a child inherits nothing from its parent, #1286).
 */
export interface ApplicationDefaults extends WorkflowDefaults {
  readonly workflows?: ChildWorkflowDefaults;
}

/**
 * What one execution of a workflow, and the tree it heads, may do (`@Workflow({ executionLimits })`,
 * #1318). Each cap is a whole number; a profile may change any of them (`workflows.<name>.executionLimits`,
 * field by field).
 */
export interface WorkflowExecutionLimits {
  /** Steps (agent, router, action and external-task visits) per execution; default (agents + routers + actions + external tasks) × 3 (#261, #1278). */
  readonly maxSteps?: number;
  /** Nesting of the workflow launching itself (#263, #264, #1287): required of a recursive workflow. */
  readonly maxDepth?: number;
  /** How many levels a path may nest before `[flow.path-too-deep]` warns (default 4, #272). */
  readonly maxPathDepth?: number;
  /**
   * How many executions of the tree — the root and all its descendants — work on a step at once
   * (#264); default 10. The rest wait in a queue (a throttle, never an error); one waiting at a
   * join or paused holds no slot. A child's own smaller value limits its subtree.
   */
  readonly maxConcurrency?: number;
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
  /**
   * How long the history of this workflow's finished executions is kept (#1318): a duration,
   * `Ttl.Forever` (never swept) or `Ttl.None` (no history is kept at all). Required — a workflow that
   * leaves it out is `[limits.history-ttl-required]`. A profile may change it
   * (`workflows.<name>.historyTtl`); every reader asks the assembly's `ComponentOptions`.
   */
  readonly historyTtl: Milliseconds | Ttl;
  /** The caps of one execution of this workflow and of its tree (#261, #263, #264, #1278, #1318). */
  readonly executionLimits?: WorkflowExecutionLimits;
  readonly defaults?: WorkflowDefaults;
  /**
   * Where this workflow runs when another launches it as a child (#1286): `CurrentProcess` (the
   * default), `AnyWorker`, `OtherWorker` or `IsolatedWorker`. Over `@Application({ defaults: {
   * workflows: { placement } } })`, never inherited from the parent.
   */
  readonly placement?: ChildPlacement;
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
  /**
   * The `@FilePolicy` of the workflow's files (#1316): how many, how large, of which media types,
   * from which origins, fetched how. Required when the workflow takes or gives a `FileDto` or reads
   * files with an agent (`[workflow.file-policy-required]`); a skill's own policy may only tighten it.
   */
  readonly filePolicy?: Class;
  /** Static `{{key}}` values of every prompt of the workflow, over the application's; a component's own win. */
  readonly promptVariables?: PromptVariables;
}

/** The flow is recorded as plain data: each path's source and steps, never the builder objects. */
const plainPath = (path: FlowPath): FlowPath => ({ source: path.source, steps: path.steps });

export function Workflow<const TName extends string, const TFlow extends readonly FlowPath[]>(
  options: WorkflowOptions<TName, TFlow>,
): (value: Class) => void {
  const source = callerFile();
  const span = captureCallSite();
  const recorded: WorkflowOptions = { ...options, flow: options.flow.map(plainPath) };
  // returns nothing: a class's own type must not depend on its decorator, or `() => ItsOwnClass`
  // inside its own `flow` would be a circular reference (TS2506, TS7022; its brand is generated)
  return (value: Class): void => {
    recordOptionKeys(value, "Workflow", options, WORKFLOW_KEYS);
    recordDeclaration(value, declared(NodeKind.Workflow, recorded, source, span));
  };
}

/** `executionLimits.maxConcurrency` of a workflow that sets none (#264). */
export const DEFAULT_MAX_CONCURRENCY = 10;

/** The limits of a workflow by its class: as declared, or as a profile leaves them. */
export type ExecutionLimitsOf = (workflow: Class) => WorkflowExecutionLimits;

const NO_LIMITS: WorkflowExecutionLimits = Object.freeze({});

/** `@Workflow({ executionLimits })` as the workflow declares it; empty for a class that is no workflow. */
export const declaredExecutionLimitsOf: ExecutionLimitsOf = (workflow) => {
  const declaration = declarationOf(workflow);
  return declaration?.kind === NodeKind.Workflow
    ? (declaration.options.executionLimits ?? NO_LIMITS)
    : NO_LIMITS;
};

/** `@Workflow({ historyTtl })` as the workflow declares it; `undefined` when unset. */
export function declaredHistoryTtlOf(workflow: Class): Milliseconds | Ttl | undefined {
  const declaration = declarationOf(workflow);
  return declaration?.kind === NodeKind.Workflow ? declaration.options.historyTtl : undefined;
}

/** A tree's concurrency cap under `limits`: the workflow's own, else the default 10. */
export const maxConcurrencyUnder = (limits: ExecutionLimitsOf, workflow: Class): number =>
  limits(workflow).maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
