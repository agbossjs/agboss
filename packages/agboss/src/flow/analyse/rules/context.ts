import type { RuleViolation } from "../../../graph/rule-error.js";
import type { WorkflowDefaults, WorkflowOptions } from "../../decorators/workflow.js";
import type { ComponentName } from "../../registry.js";
import type { Dataflow } from "../dataflow.js";
import type { ResolvedField } from "../fields.js";
import type { FlowGraph } from "../flow-graph.js";
import type { WalkedFlow } from "../walked-flow.js";

/** What every rule of the analyser reads (#272 PR 2): one workflow, walked and run to a fixed point. */

/** A module the loader found (#272 S2), with its named exports — for `[agent.dynamic-options]`. */
export interface LoadedModule {
  readonly file: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

/** Whether a model can call tools (an agent with `output` answers through answer tools, S6). */
export type ToolCallingCheck = (model: string) => boolean;

export interface AnalyseOptions {
  /** `--strict`: warnings (`[flow.path-too-deep]`) are errors. */
  readonly strict?: boolean;
  /** The project's modules, as the loader read them; without them `*.options.ts` spreads are not checked. */
  readonly modules?: readonly LoadedModule[];
  /** The models' tool calling; without it `[model.no-tool-calling]` is not checked. */
  readonly canCallTools?: ToolCallingCheck;
  /** The defaults of the workflow's `@Application` (#261): the rules read the merged defaults. */
  readonly applicationDefaults?: WorkflowDefaults;
}

export interface AnalysisContext {
  /** The workflow's options, its `defaults` merged over its application's. */
  readonly workflow: WorkflowOptions;
  readonly walked: WalkedFlow;
  readonly graph: FlowGraph;
  readonly fields: ReadonlyMap<ComponentName, readonly ResolvedField[]>;
  readonly dataflow: Dataflow;
  readonly options: AnalyseOptions;
}

/** One rule group: every violation it finds (messages without the workflow's name, added once). */
export type FlowRule = (context: AnalysisContext) => readonly RuleViolation[];
