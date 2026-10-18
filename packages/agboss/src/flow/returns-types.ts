import type {
  AfterValue,
  BuiltPath,
  PathHead,
  ReturnsOptions,
  Switching,
} from "./builder-types.js";
import type { OneOfWrapper, ReturnedShape, ValueOf } from "./dto-wrappers.js";
import type { NodeKind } from "./ast.js";
import type { GeneratedTypeError, KindOf, NameOf } from "./generated-types.js";

/**
 * The types of `.returns(…)` (#272 AC2, AC15; #299 S54): what the step gives, from the generated
 * `ProducerOutputs`. `.returns(value, options?)` names one value; a producer that gives several
 * values at once — a start whose `input` is a map of fields (#270 AC21), a join (#273, its
 * `JoinOutputs` entry) — is a tuple there, one member per value in declaration order
 * (`readonly [CompanyDto, SearchRequestDto | undefined]`), and its values are named by a chain
 * `.returns(CompanyDto).returns(optional(SearchRequestDto))`, in any order (assembly compares them
 * as a set too). `{ about }` goes on a `.returns` of one class or a list, never on a `oneOf(…)`.
 */

export type Same<TFirst, TSecond> = [TFirst] extends [TSecond]
  ? [TSecond] extends [TFirst]
    ? true
    : false
  : false;

/** Whether an output is several values at once (a tuple in `ProducerOutputs`). */
export type IsSeveral<TOutput> = TOutput extends readonly unknown[]
  ? number extends TOutput["length"]
    ? false
    : true
  : false;

/** One value of a set, kept whole: `B | undefined` stays one member when the set is a union. */
export interface Member<TValue> {
  readonly value: TValue;
}

type Members<TValues extends readonly unknown[]> = {
  [K in keyof TValues]: Member<TValues[K]>;
}[number];

type IsIn<TMember, TMembers> = TMembers extends unknown ? Same<TMember, TMembers> : never;

/**
 * The values a `.returns` chain must still name (`Member`s), or the generated entry's error: every
 * member of a tuple, else the one value.
 */
export type ValuesLeft<TOutput> = [TOutput] extends [GeneratedTypeError]
  ? TOutput
  : [TOutput] extends [readonly unknown[]]
    ? IsSeveral<TOutput> extends true
      ? Members<TOutput>
      : Member<TOutput>
    : Member<TOutput>;

/** The values left once `TValue` is named. */
type Without<TLeft, TValue> = TLeft extends unknown
  ? Same<TLeft, Member<TValue>> extends true
    ? never
    : TLeft
  : never;

/**
 * Who gives the values a `.returns` chain names: a step — its `ProducerOutputs` entry — or the join
 * of a launch — its `JoinOutputs` entry (#273).
 */
export interface ValuesSource {
  /** How a message names it: `planner-agent`, `the join`. */
  readonly label: string;
  /** The generated entry that lists the values. */
  readonly entry: string;
  /** `{ about }` is allowed — not after a start: its input answers nothing (`[io.about-on-start]`). */
  readonly takesAbout: boolean;
  /** A parallel launch may follow its values — not right after a join (#273). */
  readonly canLaunch: boolean;
}

/** The values of a step: its `ProducerOutputs` entry. */
export interface StepValues<TInstance> extends ValuesSource {
  readonly label: NameOf<TInstance>;
  readonly entry: `ProducerOutputs["${NameOf<TInstance>}"]`;
  readonly takesAbout: [KindOf<TInstance>] extends [NodeKind.Start] ? false : true;
  readonly canLaunch: true;
}

/** The values of a join: its `JoinOutputs` entry, keyed by the launch (#273). */
export interface JoinValues<TKey extends string> extends ValuesSource {
  readonly label: "the join";
  readonly entry: `JoinOutputs["${TKey}"]`;
  readonly takesAbout: true;
  readonly canLaunch: false;
}

interface NotGiven<TSource extends ValuesSource> {
  readonly __error: `not what ${TSource["label"]} gives — see ${TSource["entry"]}`;
}

/** `.returns(X)`: `unknown` when `X` is (one of) what the step gives and not named yet. */
export type ReturnsCheck<TValue, TLeft, TSource extends ValuesSource> = [TLeft] extends [
  GeneratedTypeError,
]
  ? TLeft
  : true extends IsIn<Member<TValue>, TLeft>
    ? unknown
    : NotGiven<TSource>;

/** What follows `.returns(…)`: the chain goes on while values are left; a `oneOf` is switched. */
export type AfterReturns<
  TSource extends ValuesSource,
  TLeft,
  TGiven extends readonly unknown[],
  TShape,
  THead extends PathHead,
> = [TLeft] extends [never]
  ? TShape extends OneOfWrapper
    ? BuiltPath<THead> & Switching<ValueOf<TShape>, THead>
    : AfterValue<TGiven extends readonly [infer TOne] ? TOne : TGiven, THead, TSource["canLaunch"]>
  : BuiltPath<THead> & Returning<TSource, TLeft, THead, TGiven>;

/**
 * The options a shape takes: `{ about }` beside one class or a list, nothing beside a `oneOf`, and
 * nothing after a start — its input is no answer about anything (`[io.about-on-start]`).
 */
export type ReturnsArguments<TShape, TSource extends ValuesSource> = TSource["takesAbout"] extends false
  ? []
  : TShape extends OneOfWrapper
    ? []
    : [options?: ReturnsOptions];

/**
 * `.returns(value, options?)` on a step (or a join) whose values `TLeft` are still to be named
 * (`ValuesLeft` of its generated entry); `TGiven` are the ones its chain named so far.
 */
export interface Returning<
  TSource extends ValuesSource,
  TLeft,
  THead extends PathHead,
  TGiven extends readonly unknown[] = [],
> {
  returns<const TShape extends ReturnedShape>(
    value: TShape & ReturnsCheck<ValueOf<TShape>, TLeft, TSource>,
    ...options: ReturnsArguments<TShape, TSource>
  ): AfterReturns<
    TSource,
    Without<TLeft, ValueOf<TShape>>,
    [...TGiven, ValueOf<TShape>],
    TShape,
    THead
  >;
}
