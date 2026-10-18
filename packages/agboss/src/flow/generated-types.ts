import type { NodeKind } from "./ast.js";

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

/** Each node's input, path-sensitive (`Produced` fields; a plain DTO for tools). */
export interface Inputs {
  readonly [notGenerated]?: never;
}

/** What a handler returns, by name (`OutputOf<Self>`). */
export interface Outputs {
  readonly [notGenerated]?: never;
}

/** Input and output per start: `app.execute(Start, input)` and `result.output`. */
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
 * What a code router's `route()` returns, by name (#280): one target after `.chooseOne(…)`; after
 * `.toParallelAgents(…)` (#273) a list — `readonly [Route<R>, ...Route<R>[]]` without an `Always`
 * route, so `[]` does not compile.
 */
export interface RouterAnswers {
  readonly [notGenerated]?: never;
}

/**
 * The application's environment (#261): what `ENV` gives. The generated file makes it the
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
