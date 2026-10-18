import { callerFile } from "../../components/call-site.js";
import type { Class, Provider } from "../../components/injection.js";
import type { AgentMeta } from "../../components/meta-types.js";
import type { Guardrail, PiiPolicy } from "../../components/policy-decorators.js";
import type { Price } from "../../config/types.js";
import type { Reasoning } from "../../models/reasoning.js";
import { NodeKind, type FlowPath } from "../ast.js";
import { declared, recordDeclaration } from "./declaration.js";

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
}

export interface HistoryDefaults {
  readonly limit: number;
  readonly summaries?: number;
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
  readonly history?: HistoryDefaults;
  readonly flow?: FlowDefaults;
}

/** One chat model's settings (the compaction model). */
export interface ModelOptions extends ModelDefaults {
  readonly model: string;
  /** Overrides the provider's price table; the provider's own reported cost comes first. */
  readonly price?: Price;
}

/** Conversation memory: every `every` turns become one summary; readers see the latest `keep`. */
export interface CompactionOptions {
  readonly every: number;
  readonly keep: number;
  readonly model: ModelOptions;
}

/** A guard: a flag / pass decision on the execution's input or output, tripping at `threshold`. */
export interface GuardOptions {
  readonly threshold: number;
  /** What `GuardrailBlockedError.refusal` carries when the guard trips. */
  readonly refusal: string;
  /** A decision model; `defaults.guardrail.model` when absent (#261). */
  readonly model?: string;
}

/** The workflow's guards by name, on its input and on its output (#120 replaces them). */
export interface GuardsOptions {
  readonly input?: Readonly<Record<string, GuardOptions>>;
  readonly output?: Readonly<Record<string, GuardOptions>>;
}

/**
 * `@Workflow` — the graph as paths (`flow`), the workflow's count limits and its module: services,
 * MCP servers, channels, policies and memory; observers are the application's (`@Application({
 * observers })`, #261).
 */
export interface WorkflowOptions {
  /** Ends with `-workflow` (`offer-workflow`). */
  readonly name: string;
  readonly version: string;
  readonly flow: readonly FlowPath[];
  /** Steps (agent and router visits) per execution; default (agents + routers) × 3 (#261). */
  readonly maxSteps?: number;
  /** Nesting of child workflows (#263, #264). */
  readonly maxDepth?: number;
  readonly maxConcurrentExecutions?: number;
  readonly defaults?: WorkflowDefaults;
  /** The workflow's own services for DI: classes, or values bound with `provide(TOKEN, value)`. */
  readonly providers?: readonly Provider[];
  /** `@McpServer` classes its `@McpTool`s call. */
  readonly mcp?: readonly Class[];
  readonly guards?: GuardsOptions;
  readonly piiPolicies?: readonly Class<PiiPolicy>[];
  readonly guardrails?: readonly Class<Guardrail>[];
  readonly compaction?: CompactionOptions;
  readonly compactionPrompt?: string;
  /** Static `{{key}}` values of every prompt of the workflow. */
  readonly promptVariables?: Readonly<Record<string, string>>;
}

/** The flow is recorded as plain data: each path's source and steps, never the builder objects. */
const plainPath = (path: FlowPath): FlowPath => ({ source: path.source, steps: path.steps });

export function Workflow(options: WorkflowOptions) {
  const source = callerFile();
  const recorded: WorkflowOptions = { ...options, flow: options.flow.map(plainPath) };
  return <TClass extends Class>(value: TClass): TClass => {
    recordDeclaration(value, declared(NodeKind.Workflow, recorded, source));
    return value;
  };
}
