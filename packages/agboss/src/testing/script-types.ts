import type { WorkflowFinishTextDto } from "../dto/standard/framework.js";
import type { DtoClass } from "../dto/types.js";
import type { NodeKind } from "../flow/ast.js";
import type { HistoryOf, ProducedValue } from "../flow/dto-wrappers.js";
import type {
  GeneratedTypeError,
  InputOf,
  KindOf,
  NameOf,
  NoOutput,
  OutputOf,
  ProducerOutputOf,
  Route,
  RouterAnswerOf,
} from "../flow/generated-types.js";
import type {
  AnswerTurn,
  DecideTurn,
  FailureTurn,
  ReplyTurn,
  RouteTurn,
  ScriptedTurn,
  ToolCallTurn,
  WaitTurn,
} from "./turns.js";

/**
 * What scripts and call matchers are typed by (#262, agreed 2026-10-16): the generated
 * `InputOf<X>`, `ProducerOutputOf<X>`, `Route<X>` and `RouterAnswerOf<X>` of `.agboss/types.d.ts`.
 * A component the generated types do not know (no `agboss check` yet, a judge, an arbiter) is
 * scripted unchecked.
 */

/** Whether `agboss check` branded the component: its scripts are checked. */
type IsKnown<TSelf> = [NameOf<TSelf>] extends [never] ? false : true;

/** A deep partial of a value: every key optional, lists by length and position. */
export type DeepPartial<TValue> = TValue extends readonly (infer TElement)[]
  ? readonly DeepPartial<TElement>[]
  : TValue extends object
    ? { readonly [TKey in keyof TValue]?: DeepPartial<TValue[TKey]> }
    : TValue;

/** One value read from the path, as a matcher writes it: its value only (`producer` is not compared). */
type ValuePartial<TField> =
  TField extends ProducedValue<infer TValue, unknown> ? DeepPartial<TValue> : DeepPartial<TField>;

/** One input field as a matcher writes it: `undefined` = absent, a list by position. */
type FieldPartial<TField> = TField extends undefined
  ? undefined
  : TField extends HistoryOf<infer TVersion>
    ? {
        readonly current?: ValuePartial<TVersion>;
        readonly previous?: readonly ValuePartial<TVersion>[];
      }
    : TField extends readonly (infer TElement)[]
      ? readonly ValuePartial<TElement>[]
      : ValuePartial<TField>;

/**
 * A matcher over a node's input values (#262 S-scripts): a deep partial of each field's `value` —
 * `Produced<V, P>` unwrapped, a plain field taken as it is. A key left out is not checked; a key
 * given as `undefined` matches only an absent field; a `listOf` field is compared by length and
 * position, a `oneOf` element may be `variant(XDto, { … })` to match its class.
 */
export type PartialValues<TInput> = TInput extends GeneratedTypeError
  ? never
  : TInput extends unknown
    ? { readonly [TKey in keyof TInput]?: FieldPartial<TInput[TKey]> }
    : never;

/** What `when(…)` / `toHaveBeenCalledWith(…)` take for a component. */
export type InputMatcherOf<TSelf> =
  IsKnown<TSelf> extends true ? PartialValues<InputOf<TSelf>> : Readonly<Record<string, unknown>>;

/** What `mockLlm(X).inputs` / `mockAction(A).inputs` hold: the node's input as it read it. */
export type RecordedInputOf<TSelf> =
  IsKnown<TSelf> extends true ? InputOf<TSelf> : Readonly<Record<string, unknown>>;

/** The answer turns an agent's output allows: one class of it (a `oneOf`'s variants), or a list. */
type AnswerFor<TOutput> = [TOutput] extends [NoOutput]
  ? never
  : [TOutput] extends [GeneratedTypeError]
    ? AnswerTurn
    : TOutput extends readonly (infer TElement)[]
      ? AnswerTurn<TElement, true>
      : AnswerTurn<TOutput, false>;

/** An agent's turns: text, tool calls, failures, waits — and answers of its output's classes only. */
type AgentTurnFor<TSelf> =
  ReplyTurn | ToolCallTurn | FailureTurn | WaitTurn | AnswerFor<ProducerOutputOf<TSelf>>;

/** A route turn as the router answers: one target, or the list it launches. */
type RouteFor<TAnswer, TRoute> = [TAnswer] extends [GeneratedTypeError]
  ? RouteTurn<readonly [TRoute]>
  : TAnswer extends readonly unknown[]
    ? RouteTurn<TAnswer>
    : RouteTurn<readonly [TAnswer]>;

/** A model router's turns: `routeTo(…)` as `Route<R>` allows, decisions, failures, waits. */
type RouterTurnFor<TSelf> =
  FailureTurn | WaitTurn | DecideTurn | RouteFor<RouterAnswerOf<TSelf>, Route<TSelf>>;

/**
 * A model reply interpreter's turns (#267): an agent's (a chat model's answer) or `decideWith(…)`
 * (a decision model's yes / no, S124 a) — its decorator's model, not its generated types, says which.
 */
type ReplyInterpreterTurnFor<TSelf> = AgentTurnFor<TSelf> | DecideTurn;

/** The turns `mockLlm(X).thenReturn(…)` accepts for a component. */
export type TurnFor<TSelf> =
  IsKnown<TSelf> extends false
    ? ScriptedTurn
    : NameOf<TSelf> extends `${string}-reply-interpreter`
      ? ReplyInterpreterTurnFor<TSelf>
      : KindOf<TSelf> extends NodeKind.Agent
        ? AgentTurnFor<TSelf>
        : KindOf<TSelf> extends NodeKind.Router
          ? RouterTurnFor<TSelf>
          : ScriptedTurn;

/** What a node returns, as `toHaveReturned` names it: an agent's answer, an action's result. */
type ReturnedOf<TSelf> =
  KindOf<TSelf> extends NodeKind.Agent
    ? ProducerOutputOf<TSelf>
    : KindOf<TSelf> extends NodeKind.Action
      ? OutputOf<TSelf>
      : unknown;

/** The value classes a component returns (a text agent: `WorkflowFinishTextDto`). */
type ReturnedValueOf<TReturned> = [TReturned] extends [NoOutput]
  ? WorkflowFinishTextDto
  : TReturned extends readonly (infer TElement)[]
    ? TElement
    : TReturned;

/** `toHaveReturned(XDto, …)` takes a class the component returns; else a type error naming it. */
export type ReturnedCheckOf<TSelf, TDto extends DtoClass> =
  IsKnown<TSelf> extends false
    ? unknown
    : InstanceType<TDto> extends ReturnedValueOf<ReturnedOf<TSelf>>
      ? unknown
      : { readonly __error: "toHaveReturned: the component does not return this class" };
