import type { Class } from "../components/injection.js";
import type { NodeKind } from "./ast.js";
import type { HistoryOf } from "./dto-wrappers.js";
import type { WithoutTrack } from "./metadata.js";
import type {
  agbossDto,
  AGBossTypes,
  GeneratedEntry,
  GeneratedTypeError,
  InputOf,
  KindOf,
  MissingGeneratedTypes,
  OutputOf,
} from "./generated-types.js";
import type { BuiltPath, ClaimsOfPath, IsUnion, PathHead, SidePath } from "./builder-types.js";

/**
 * What the branches of `.toOneOf([…])` and `.onFinish(…)` read, in types (#1275c): a side path
 * carries the DTOs its entry consumer reads, and the call does not compile unless they fit the
 * variants of the `oneOf(…)` (one branch per variant, one branch may read none) or the finishes of
 * the child (each named once).
 */

/** The DTO a field of an input reads: a list reads none, a history its current value. */
export type FieldDto<TField> = [TField] extends [readonly unknown[]]
  ? never
  : TField extends HistoryOf<infer TValue>
    ? PlainDto<TValue>
    : PlainDto<TField>;

export type PlainDto<TValue> = TValue extends undefined ? never : WithoutTrack<TValue>;

/** The DTOs a node's input reads (#1275c): one DTO, or one per field of a map; `never` for none. */
export type ClaimedDtosOf<TInput> = TInput extends GeneratedTypeError
  ? never
  : TInput extends MissingGeneratedTypes
    ? never
    : typeof agbossDto extends keyof TInput
      ? TInput
      : TInput extends object
        ? { [K in keyof TInput]-?: FieldDto<TInput[K]> }[keyof TInput]
        : never;

/** What the entry consumer of a path starting with `TInstance` reads: a finish its output. */
export type SideClaimsOf<TInstance> = [KindOf<TInstance>] extends [NodeKind.Finish]
  ? PlainDto<OutputOf<TInstance>> extends infer TOut
    ? [TOut] extends [GeneratedTypeError | MissingGeneratedTypes]
      ? never
      : TOut extends readonly unknown[]
        ? never
        : TOut
    : never
  : ClaimedDtosOf<InputOf<TInstance>>;

export interface OneOfError<TMessage extends string> {
  readonly __error: TMessage;
}

/** Checks the claims of the branches, in order, against the variants: `unknown` when they fit. */
export type CheckClaims<
  TClaims extends readonly unknown[],
  TVariants,
  TSeen = never,
  TLoose extends readonly unknown[] = [],
> = TClaims extends readonly [infer TFirst, ...infer TRest]
  ? [TFirst] extends [never]
    ? CheckClaims<TRest, TVariants, TSeen, [...TLoose, unknown]>
    : true extends IsUnion<TFirst>
      ? OneOfError<"a branch reads several variants of the oneOf — a branch takes exactly one">
      : [Extract<TSeen, TFirst>] extends [never]
        ? CheckClaims<TRest, TVariants, TSeen | TFirst, TLoose>
        : OneOfError<"two branches read one variant of the oneOf — a variant has one branch">
  : [Exclude<TVariants, TSeen>] extends [never]
    ? TLoose extends readonly []
      ? unknown
      : OneOfError<"a branch reads no variant and none is left — one branch may read none">
    : TLoose extends readonly [unknown]
      ? true extends IsUnion<Exclude<TVariants, TSeen>>
        ? OneOfError<"the oneOf is not exhaustive — a variant has no branch">
        : unknown
      : OneOfError<"the oneOf is not exhaustive — a variant has no branch">;

/** `.toOneOf([…])` takes one branch per variant of the output (#1275c). */
export type OneOfCheck<TBranches extends readonly SidePath[], TOutput> = CheckClaims<
  { [K in keyof TBranches]: Extract<TOutput, ClaimsOfPath<TBranches[K]>> },
  TOutput
>;

/** The finishes a child workflow ends at, as classes; `never` for anything else or before generation. */
export type FinishesOf<TInstance> =
  GeneratedEntry<AGBossTypes.WorkflowFinishes, TInstance> extends infer TEntry
    ? TEntry extends Class
      ? TEntry
      : never
    : never;

/** After a child workflow with two or more finishes: `.onFinish(ChildFinish, subPath)` (#1275b). */
export type WithFinishes<TInstance, THead extends PathHead> =
  true extends IsUnion<FinishesOf<TInstance>>
    ? FinishHandling<TInstance, THead, FinishesOf<TInstance>>
    : unknown;

/**
 * `.onFinish(KycFraudFinish, toAction(X)…)`: the path one finish of the child takes, named by the
 * finish's component class — never by a DTO, two finishes may give one. `TRemaining` are the
 * finishes not yet named; the chain is a path only when none is left (#1275c).
 */
export interface FinishHandling<TInstance, THead extends PathHead, TRemaining> {
  onFinish<const TFinish extends TRemaining>(
    finish: TFinish,
    path: SidePath,
  ): WorkflowFinishStep<TInstance, THead, Exclude<TRemaining, TFinish>>;
}

/** The chain after an `.onFinish(…)`: a built path when every finish is named, else only more of them. */
export type WorkflowFinishStep<TInstance, THead extends PathHead, TRemaining> = [
  TRemaining,
] extends [never]
  ? BuiltPath<THead>
  : FinishHandling<TInstance, THead, TRemaining> & {
      readonly __error: "a finish of the child workflow has no .onFinish(…)";
    };
