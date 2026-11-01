import type { NodeKind } from "./ast.js";
import type { ExecutionOptions } from "../app/types.js";
import type { ContextValues, TenantValues } from "./context/context-values.js";
import type {
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
} from "../dto/standard/framework.js";

export type { HistoryOf, Produced } from "./dto-wrappers.js";

/**
 * The tables `.agboss/types.d.ts` fills by declaration merging (#272 S3, #270 → Generated types).
 * Every table is keyed by the component's `name`; every component class is branded with its name
 * (`readonly [agbossComponent]?: "draft-agent"`, merged into the class's instance type), so empty
 * classes become distinct types. Before generation a lookup gives `MissingGeneratedTypes`, which
 * names the fix. Until PR 4 exports this module from `agboss`, the generator (`flow/types/`) augments
 * it here; it imports `Produced` and `HistoryOf` from here too, so the generated file names one module.
 */

/** The brand key on component classes; its value is the component's `name`. */
export const agbossComponent: unique symbol = Symbol("agboss.component");

/** The brand key on DTO classes; its value is the class name (keeps empty marker DTOs distinct). */
export const agbossDto: unique symbol = Symbol("agboss.dto");

/** Never set: keeps a table a type of its own until the generated file adds its entries. */
declare const notGenerated: unique symbol;

declare const noOutput: unique symbol;
declare const noInput: unique symbol;

/** A producer without `output` (an `@Action` done for its side effect): no `.returns` after it. */
export interface NoOutput {
  readonly [noOutput]: true;
}

/** A node that declares no `input`. */
export interface NoInput {
  readonly [noInput]?: never;
}

/** What a lookup gives before `agboss check` has written the types. */
export interface MissingGeneratedTypes {
  readonly __error: "Missing generated types — run `agboss check` to update .agboss/types.d.ts";
}

/** A generated entry that reports a problem instead of a type (any table may hold one). */
export interface GeneratedTypeError {
  readonly __error: string;
}

/** What every producer gives, by name: starts (their input), agents, actions; `NoOutput` for none. */
export interface ProducerOutputs {
  readonly [notGenerated]?: never;
}

/**
 * What the join of each launch gives (#273), keyed by the launch as written —
 * `toParallelAgents(researcher-agent, critic-agent, critic-agent)`,
 * `support-router.toParallelAgents(…)`, `toParallelAgents(company-check-agent) per item`: one value
 * per class the branches give (a tuple for several), `listOf` for copies and per-item runs,
 * `optional` for a branch that may be missing; `NoOutput` when its actions give nothing.
 */
export interface JoinOutputs {
  readonly [notGenerated]?: never;
}

/**
 * `ThisWorkflow` per recursive workflow (#264 S112), keyed by the workflow's `name`: `input` — the
 * problems of launching it (`[graph.no-matching-start]`, `[input.missing-on-path]`, …) or
 * `NoInput`; `output` — what one child gives (its finishes' outputs); `join` — what the join of its
 * per-item launch gives, when it has one. `@Workflow({ name, flow })` checks the `.returns(…)` after
 * each `ThisWorkflow` launch of its flow against it.
 */
export interface ThisWorkflowOutputs {
  readonly [notGenerated]?: never;
}

/** Each node's input, path-sensitive (`Produced` fields; a plain DTO for tools). */
export interface Inputs {
  readonly [notGenerated]?: never;
}

/** What a handler returns, by name (`OutputOf<Self>`). */
export interface Outputs {
  readonly [notGenerated]?: never;
}

/**
 * Input and output per start: `app.execute(Start, input)` and `result.output`; `tenant` /
 * `execution` — the context subclasses its application declares (#261), typing the options.
 */
export interface WorkflowStarts {
  readonly [notGenerated]?: never;
}

/**
 * The DTO classes the generated file brands, by class name (S39): each is augmented with
 * `readonly [agbossDto]?: "XDto"`, so empty marker DTOs and same-shaped DTOs are distinct types.
 */
export interface DtoBrands {
  readonly [notGenerated]?: never;
}

/** The targets a router decides on (`Route<R>`, #280): its `SpawnPolicy.Always` routes left out. */
export interface Routes {
  readonly [notGenerated]?: never;
}

/**
 * What a router answers, by name: a code router's `route()` (#280), a model router's scripted
 * `routeTo(…)` in tests (#262) — one target after `.chooseOne(…)`; after `.toParallelAgents(…)`
 * (#273) a list — `readonly [Route<R>, ...Route<R>[]]` without an `Always` route, so `[]` does
 * not compile.
 */
export interface RouterAnswers {
  readonly [notGenerated]?: never;
}

/**
 * What each channel role asks and how it is answered (#267), by the role's `name`: a role with
 * `approves: XDto` asks `ToolCallApprovalAskDto` with `arguments: XDto` and is answered with
 * `ToolCallApprovalDecisionDto` with `overrideArguments?: XDto`. A concrete `@Channel` a tool names
 * as is approves those tools. The
 * built-in channels approve any tool.
 */
export interface ChannelRoles {
  readonly [notGenerated]?: never;
  readonly "terminal-user-channel": {
    readonly ask: ToolCallApprovalAskDto;
    readonly answer: ToolCallApprovalDecisionDto;
  };
  readonly "auto-approve-channel": {
    readonly ask: ToolCallApprovalAskDto;
    readonly answer: ToolCallApprovalDecisionDto;
  };
  readonly "auto-reject-channel": {
    readonly ask: ToolCallApprovalAskDto;
    readonly answer: ToolCallApprovalDecisionDto;
  };
}

/**
 * What a channel of `TRole` is asked (`ChannelAsk<TRole>["value"]`), from the generated
 * `ChannelRoles` entry of the role: the tool call it approves; `MissingGeneratedTypes` before
 * `agboss check`.
 */
export type ChannelQuestionOf<TRole> =
  GeneratedEntry<ChannelRoles, TRole> extends { readonly ask: infer TAsk }
    ? TAsk
    : MissingGeneratedTypes;

/**
 * The answer that decides a pause of `TRole` (`ChannelOutcome.decided(…)`, a reply): the
 * `ToolCallApprovalDecisionDto` of the role's `approves`; `MissingGeneratedTypes` before
 * `agboss check`.
 */
export type ChannelAnswerOf<TRole> =
  GeneratedEntry<ChannelRoles, TRole> extends { readonly answer: infer TAnswer }
    ? TAnswer
    : MissingGeneratedTypes;

/**
 * The application's environment (#261): `applicationContext.environment`. The generated file makes it the
 * application's contract — `interface Environment extends AppEnvironment {}` for
 * `@Application({ environment: AppEnvironment })`; the project writes no `declare module`.
 */
export interface Environment {
  readonly [notGenerated]?: never;
}

/** The `name` a branded component carries; `never` when it is not branded (not generated). */
export type NameOf<TInstance> = TInstance extends {
  readonly [agbossComponent]?: infer TName extends string;
}
  ? string extends TName
    ? never
    : TName
  : never;

/** A component's kind, read from its name's suffix (`-agent`, `-router`, … — `[name.kind-suffix]`). */
export type KindOfName<TName extends string> = TName extends `${string}-workflow-start`
  ? NodeKind.Start
  : TName extends `${string}-workflow-finish`
    ? NodeKind.Finish
    : TName extends `${string}-workflow`
      ? NodeKind.Workflow
      : TName extends `${string}-agent`
        ? NodeKind.Agent
        : TName extends `${string}-router`
          ? NodeKind.Router
          : TName extends `${string}-action`
            ? NodeKind.Action
            : never;

/** A component's kind from its brand; `never` when it is not branded. */
export type KindOf<TInstance> = KindOfName<NameOf<TInstance>>;

/** An entry of a generated table for a component, or `MissingGeneratedTypes`. */
export type GeneratedEntry<TTable, TInstance> =
  NameOf<TInstance> extends infer TName extends keyof TTable
    ? [TName] extends [never]
      ? MissingGeneratedTypes
      : TTable[TName]
    : MissingGeneratedTypes;

/** A node's input as its handler takes it (`execute(input: InputOf<Self>)`). */
export type InputOf<TInstance> = GeneratedEntry<Inputs, TInstance>;

/** What a handler returns (`Promise<OutputOf<Self>>`). */
export type OutputOf<TInstance> = GeneratedEntry<Outputs, TInstance>;

/** What a producer gives on the path (`.returns(…)` is checked against it). */
export type ProducerOutputOf<TInstance> = GeneratedEntry<ProducerOutputs, TInstance>;

/** What the join of a launch gives (`.join().returns(…)` is checked against it, #273). */
export type JoinOutputOf<TKey extends string> = [TKey] extends [never]
  ? MissingGeneratedTypes
  : TKey extends keyof JoinOutputs
    ? JoinOutputs[TKey]
    : MissingGeneratedTypes;

/** One target a router decides on (#280): the union of its routes' targets but `Always` ones. */
export type Route<TInstance> = GeneratedEntry<Routes, TInstance>;

/** What a code router's `route()` returns: `Route<Self>`, or a list of it before a launch. */
export type RouterAnswerOf<TInstance> = GeneratedEntry<RouterAnswers, TInstance>;

/** The generated entry of a start: `{ input; output }`. */
type WorkflowStartEntry<TInstance> = GeneratedEntry<WorkflowStarts, TInstance>;

/** What `app.execute(Start, input)` takes: the start's input as plain DTOs (#270). */
export type ExecutionInputOf<TInstance> =
  WorkflowStartEntry<TInstance> extends { readonly input: infer TInput }
    ? TInput
    : WorkflowStartEntry<TInstance>;

/** What `result.output` is after `app.execute(Start, …)`: the outputs of the finishes it reaches. */
export type ExecutionOutputOf<TInstance> =
  WorkflowStartEntry<TInstance> extends { readonly output: infer TOutput } ? TOutput : unknown;

/**
 * The context classes of a start's application (#261), from its generated entry: `tenant` and
 * `execution` are there only when the application declares its own subclass.
 */
type StartTenantOf<TInstance> =
  WorkflowStartEntry<TInstance> extends { readonly tenant: infer TTenant } ? TTenant : never;
type StartExecutionOf<TInstance> =
  WorkflowStartEntry<TInstance> extends { readonly execution: infer TExecution }
    ? TExecution
    : never;

/** `tenant`: the declared subclass's values, required; else the built-in `{ tenantId?, weight? }`. */
type TenantOptionOf<TInstance> = [StartTenantOf<TInstance>] extends [never]
  ? { readonly tenant?: TenantValues }
  : { readonly tenant: ContextValues<StartTenantOf<TInstance>> };

/** `execution`: the declared subclass's values, required; with the built-in class it does not compile. */
type ExecutionOptionOf<TInstance> = [StartExecutionOf<TInstance>] extends [never]
  ? { readonly execution?: never }
  : { readonly execution: ContextValues<StartExecutionOf<TInstance>> };

/** What `app.execute(Start, input, options)` takes for a start: its application's contexts typed. */
export type ExecutionOptionsOf<TInstance> = Omit<ExecutionOptions, "tenant" | "execution"> &
  TenantOptionOf<TInstance> &
  ExecutionOptionOf<TInstance>;

/** The options argument of `app.execute`: required when the start's application declares contexts. */
export type ExecutionOptionsArgs<TInstance> = [
  StartTenantOf<TInstance> | StartExecutionOf<TInstance>,
] extends [never]
  ? [options?: ExecutionOptionsOf<TInstance>]
  : [options: ExecutionOptionsOf<TInstance>];
