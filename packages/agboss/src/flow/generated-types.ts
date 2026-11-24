import type { NodeKind } from "./ast.js";
import type { ExecutionOptions } from "../app/types.js";
import type { ContextValues, TenantValues } from "./context/context-values.js";
import type {
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
} from "../dto/standard/framework.js";

export type { HistoryOf, Produced, VariantOf } from "./dto-wrappers.js";
// the brand `.agboss/types.d.ts` puts on an `@Application` class (#1324e)
export { agbossTenantContext } from "../app/tenant-args.js";
/** The kinds a brand carries (`NodeKind.Agent`): the generated file imports it from here. */
export type { NodeKind };

/**
 * The tables `.agboss/types.d.ts` fills by declaration merging (#272 S3, #270 → Generated types).
 * Every table is keyed by the component's `name`; every component class is branded with its name and
 * kind (`readonly [agbossComponent]?: { readonly name: "draft-agent"; readonly kind: NodeKind.Agent }`,
 * merged into the class's instance type), so empty
 * classes become distinct types. Before generation a lookup gives `MissingGeneratedTypes`, which
 * names the fix. Until PR 4 exports this module from `@agboss/core`, the generator (`flow/types/`) augments
 * it here; it imports `Produced` and `HistoryOf` from here too, so the generated file names one module.
 */

/**
 * The brand key on component classes: its value is `{ name, kind }`, merged into the class's instance
 * type by `.agboss/types.d.ts` only (a decorator never types its class, so a recursive reference
 * to a class from inside its own decorator argument compiles, #1287).
 */
export const agbossComponent: unique symbol = Symbol("agboss.component");

/** The brand key on DTO classes; its value is the class name (keeps empty marker DTOs distinct). */
export const agbossDto: unique symbol = Symbol("agboss.dto");

/** Never set: keeps a table a type of its own until the generated file adds its entries. */
declare const notGenerated: unique symbol;

declare const noOutput: unique symbol;
declare const noInput: unique symbol;

/** A producer without `output` (an `@Action` done for its side effect): it gives no value. */
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

/**
 * The tables `.agboss/types.d.ts` fills by declaration merging, one namespace so a generated file
 * adds nothing else to `@agboss/core`'s names (#1324g): `AGBossTypes.Inputs`, `.Outputs`, …
 */
export declare namespace AGBossTypes {
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

  /**
   * Input and output per start: `app.execute(Start, input)` and `result.output`; `tenant` /
   * `execution` — the context subclasses its application declares (#261), typing the options.
   */
  export interface WorkflowStarts {
    readonly [notGenerated]?: never;
  }

  /**
   * The finishes of each child workflow by its `name`, as classes (`typeof KycFraudFinish | …`):
   * what `.onFinish(ChildFinish, subPath)` names after `.toWorkflow(W)` (#1275b).
   */
  export interface WorkflowFinishes {
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
   * (#273) a list, `readonly Route<R>[]`, which may be empty (#1279).
   */
  export interface RouterAnswers {
    readonly [notGenerated]?: never;
  }

  /**
   * What each channel role asks and how it is answered (#267), by the role's `name`: a role with
   * `approves: XDto` asks `ToolCallApprovalAskDto` with `arguments: XDto` and is answered with
   * `ToolCallApprovalDecisionDto` with `overrideArguments?: XDto`; a question role (#659) with `ask` /
   * `answer` asks and is answered with those DTOs. A concrete `@Channel` a tool names as is approves
   * those tools. The built-in channels approve any tool.
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
   * What each pause target asks and is answered with (#1307), by the target's `name`:
   * `@ToolApproval` — `input` the gated tools' input, `output` the `ApprovalDecision` of it;
   * `@ExternalTask` — its `input` and `output` DTOs.
   */
  export interface PauseTargets {
    readonly [notGenerated]?: never;
  }

  /**
   * The tools an agent's model may call, by the agent's `name` (#679): the names its scripted
   * `callTool(…)` / `callTools(…)` turns are checked against — its `@Tool` classes and
   * its tool-mode knowledge bases' `search-<rag>-tool`.
   */
  export interface AgentTools {
    readonly [notGenerated]?: never;
  }

  /**
   * The output each `@Judge` judges, by the judge's `name` (#1290): `JudgeInput<Self>` reads it —
   * the output's value as the judge gets it (`readonly VariantOf<A | B>[]` for a `listOf(oneOf(A, B))`).
   */
  export interface JudgeOutputs {
    readonly [notGenerated]?: never;
  }
}

/**
 * What a channel of `TRole` is asked (`ChannelAsk<TRole>["value"]`), from the generated
 * `ChannelRoles` entry of the role: the tool call an approval role approves, a question role's
 * `ask` (#659); `MissingGeneratedTypes` before `agboss check`.
 */
export type ChannelQuestionOf<TRole> =
  GeneratedEntry<AGBossTypes.ChannelRoles, TRole> extends { readonly ask: infer TAsk }
    ? TAsk
    : MissingGeneratedTypes;

/**
 * What a pause of `TRole` asks as a channel and a hook read it (`ChannelAsk<TRole>["input"]`): an
 * approval role's tool arguments (the `arguments` of its generated ask), a question role's `ask`
 * DTO as it is (#659); `MissingGeneratedTypes` before `agboss check`.
 */
export type ChannelInputOf<TRole> =
  ChannelQuestionOf<TRole> extends {
    readonly callId: string;
    readonly tool: string;
    readonly arguments: infer TArguments;
  }
    ? TArguments
    : ChannelQuestionOf<TRole>;

/**
 * The answer that decides a pause of `TRole` (`ChannelOutcome.decided(…)`, a reply): the
 * `ToolCallApprovalDecisionDto` of an approval role's `approves`, a question role's `answer` (#659);
 * `MissingGeneratedTypes` before `agboss check`.
 */
export type ChannelAnswerOf<TRole> =
  GeneratedEntry<AGBossTypes.ChannelRoles, TRole> extends { readonly answer: infer TAnswer }
    ? TAnswer
    : MissingGeneratedTypes;

/** What a pause of `TTarget` asks (its generated `PauseTargets` entry); `never` for `never`. */
export type PauseInputOf<TTarget> = [TTarget] extends [never]
  ? never
  : GeneratedEntry<AGBossTypes.PauseTargets, TTarget> extends { readonly input: infer TInput }
    ? TInput
    : MissingGeneratedTypes;

/** What answers a pause of `TTarget` (its generated `PauseTargets` entry); `never` for `never`. */
export type PauseOutputOf<TTarget> = [TTarget] extends [never]
  ? never
  : GeneratedEntry<AGBossTypes.PauseTargets, TTarget> extends { readonly output: infer TOutput }
    ? TOutput
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
export type NameOf<T> =
  InstanceOrSelf<T> extends {
    readonly [agbossComponent]?: { readonly name: infer TName extends string };
  }
    ? string extends TName
      ? never
      : TName
    : never;

/** An instance's own type, or the instance type of a class: a lookup takes either. */
export type InstanceOrSelf<T> = T extends abstract new (...args: never[]) => infer TInstance
  ? TInstance
  : T;

/** A component's kind from its brand; `never` when it is not branded or its brand has no kind. */
export type KindOf<T> =
  InstanceOrSelf<T> extends {
    readonly [agbossComponent]?: { readonly kind: infer TKind extends NodeKind };
  }
    ? NodeKind extends TKind
      ? never
      : TKind
    : never;

/** An entry of a generated table for a component, or `MissingGeneratedTypes`. */
export type GeneratedEntry<TTable, TInstance> =
  NameOf<TInstance> extends infer TName extends keyof TTable
    ? [TName] extends [never]
      ? MissingGeneratedTypes
      : TTable[TName]
    : MissingGeneratedTypes;

/**
 * The tools an agent's model may call, by the agent's `name` (#679): the names its scripted
 * `callTool(…)` / `callTools(…)` turns are checked against — its `@Tool` classes and
 * its tool-mode knowledge bases' `search-<rag>-tool`.
 */
export interface AgentTools {
  readonly [notGenerated]?: never;
}

/**
 * The tool names an agent's scripted calls may name (#679): its `AgentTools` entry, `string` for a
 * component without generated types (then nothing is checked).
 */
export type AgentToolNamesOf<TSelf> =
  GeneratedEntry<AGBossTypes.AgentTools, TSelf> extends infer TNames extends string
    ? TNames
    : string;

/** The name an agent's model calls a tool class by (#679): its brand, `string` before `agboss check`. */
export type ToolNameOf<TTool> = [NameOf<TTool>] extends [never] ? string : NameOf<TTool>;

/** A node's input as its handler takes it (`execute(input: InputOf<Self>)`). */
export type InputOf<TInstance> = GeneratedEntry<AGBossTypes.Inputs, TInstance>;

/** What a handler returns (`Promise<OutputOf<Self>>`). */
export type OutputOf<TInstance> = GeneratedEntry<AGBossTypes.Outputs, TInstance>;

/** What a producer gives on the path: the value the flow continues with. */
export type ProducerOutputOf<TInstance> = GeneratedEntry<AGBossTypes.ProducerOutputs, TInstance>;

/** One target a router decides on (#280): the union of its routes' targets but `Always` ones. */
export type Route<TInstance> = GeneratedEntry<AGBossTypes.Routes, TInstance>;

/** What a code router's `route()` returns: `Route<Self>`, or a list of it before a launch. */
export type RouterAnswerOf<TInstance> = GeneratedEntry<AGBossTypes.RouterAnswers, TInstance>;

/** The generated entry of a start: `{ input; output }`. */
export type WorkflowStartEntry<TInstance> = GeneratedEntry<AGBossTypes.WorkflowStarts, TInstance>;

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
export type StartTenantOf<TInstance> =
  WorkflowStartEntry<TInstance> extends { readonly tenant: infer TTenant } ? TTenant : never;
export type StartExecutionOf<TInstance> =
  WorkflowStartEntry<TInstance> extends { readonly execution: infer TExecution }
    ? TExecution
    : never;

/** `tenant`: the declared subclass's values, required; else the built-in `{ tenantId?, weight? }`. */
export type TenantOptionOf<TInstance> = [StartTenantOf<TInstance>] extends [never]
  ? { readonly tenant?: TenantValues }
  : { readonly tenant: ContextValues<StartTenantOf<TInstance>> };

/** `execution`: the declared subclass's values, required; with the built-in class it does not compile. */
export type ExecutionOptionOf<TInstance> = [StartExecutionOf<TInstance>] extends [never]
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
