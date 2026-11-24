import type { PromptValue } from "../components/prompt-source.js";
import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { DecidedBy } from "../flow/decorators/router.js";
import type { InputOf, OutputOf } from "../flow/generated-types.js";
import { resolvedName } from "../flow/names.js";

/**
 * `@ReplyInterpreter` (#267 PR 3): who turns a free-text reply to a pause into its role's typed
 * answer — named on the role (`@ChannelRole({ replyInterpreter })`), one interpreter per role. It gets
 * the pause's original question and the reply (`{ ask, reply }`); what it returns is validated like
 * any decision. `DecidedBy.Model` — its chat model answers through one answer tool, a decision model
 * (an approval role's only, `[reply-interpreter.decision-model]` for a question role) through one `Decision.boolean("approved")` (static `prompt` / `promptUrls`;
 * `ask` and `reply` come in the input message); `DecidedBy.Code` — the class's `interpret(input)`
 * (`implements ReplyInterpreterHandler<Self>`), returning a `ReplyInterpretation`. Code downstream
 * decides by types, never by text.
 */

/** `@ReplyInterpreter({ decidedBy: DecidedBy.Model })`: one answer tool on a chat model. */
export interface ModelReplyInterpreterOptions {
  /** Kebab-case; the class name in kebab-case when left out (`Refund` → `refund`). */
  readonly name?: string;
  readonly description?: string;
  readonly decidedBy: DecidedBy.Model;
  /**
   * A chat model (one answer tool), or — for an approval role only — a decision model (one
   * `Decision.boolean("approved")`: approve / refuse, no `reason`, no `overrideArguments`, #267 S124 a);
   * a decision model for a question role is `[reply-interpreter.decision-model]`.
   */
  readonly model: string;
  /** How to read a reply; static — the question and the reply come in the input message. */
  readonly prompt?: PromptValue;
  readonly promptUrls?: readonly string[];
  readonly deps?: never;
}

/** `@ReplyInterpreter({ decidedBy: DecidedBy.Code })`: the class's `interpret(input)`. */
export interface CodeReplyInterpreterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case; the class name in kebab-case when left out (`Refund` → `refund`). */
  readonly name?: string;
  readonly description?: string;
  readonly decidedBy: DecidedBy.Code;
  /** Constructor dependencies, in order; compiler-checked. */
  readonly deps?: TDeps;
  readonly model?: never;
  readonly prompt?: never;
  readonly promptUrls?: never;
}

/** `@ReplyInterpreter` options: a union discriminated by `decidedBy`. */
export type ReplyInterpreterOptions = ModelReplyInterpreterOptions | CodeReplyInterpreterOptions;

/** What `@ReplyInterpreter` recorded on a class: its options and the file it is declared in. */
export interface ReplyInterpreterDeclaration {
  /** The options, with `name` resolved: given, or the class name in kebab-case. */
  readonly options: ReplyInterpreterOptions & { readonly name: string };
  readonly source?: string;
  /** Declared with `@ChannelInterpreter` (#1310c): its rules carry the new codes. */
  readonly isChannelInterpreter?: true;
}

/** The two outcomes of a code interpreter's `interpret` (#267 S124 b). */
export enum ReplyInterpretationKind {
  /** The reply was read: its decision is validated like any other. */
  Understood = "understood",
  /** The reply says nothing the interpreter can read: the pause stays pending. */
  NotUnderstood = "not-understood",
}

declare const replyInterpretation: unique symbol;

/** The reply was read as `decision`. */
export interface UnderstoodReply<TDecision> {
  /** A mark only `ReplyInterpretation.understood` / `.notUnderstood` give. */
  readonly [replyInterpretation]: true;
  readonly kind: ReplyInterpretationKind.Understood;
  readonly decision: TDecision;
}

/** The reply was not understood: `reason` is the `UninterpretableReplyError`'s. */
export interface NotUnderstoodReply {
  /** A mark only `ReplyInterpretation.understood` / `.notUnderstood` give. */
  readonly [replyInterpretation]: true;
  readonly kind: ReplyInterpretationKind.NotUnderstood;
  readonly reason: string;
}

/** What `interpret` returns: `ReplyInterpretation.understood(…)` or `.notUnderstood({ reason })`. */
export type ReplyInterpretation<TDecision> = UnderstoodReply<TDecision> | NotUnderstoodReply;

/** `ReplyInterpretation.notUnderstood({ reason })` — why the reply could not be read. */
export interface NotUnderstoodReplyOptions {
  readonly reason: string;
}

/** The only way to build an interpretation (#267 S124 b, like `JudgeVerdict` and `ChannelOutcome`). */
export const ReplyInterpretation = {
  /** The reply was read as `decision`: validated like a decision given to `app.resume`. */
  understood<TDecision>(decision: TDecision): UnderstoodReply<TDecision> {
    const built = { kind: ReplyInterpretationKind.Understood, decision } as const;
    return Object.freeze(built) as UnderstoodReply<TDecision>;
  },
  /** The reply was not understood: `app.resume` throws `UninterpretableReplyError` with `reason`. */
  notUnderstood(options: NotUnderstoodReplyOptions): NotUnderstoodReply {
    const built = { kind: ReplyInterpretationKind.NotUnderstood, reason: options.reason } as const;
    return Object.freeze(built) as NotUnderstoodReply;
  },
} as const;

/**
 * A code interpreter's contract: `interpret({ ask, reply })` gives the role's answer —
 * `InputOf<Self>` / `OutputOf<Self>` from the generated types — as `ReplyInterpretation.understood(…)`,
 * or `ReplyInterpretation.notUnderstood({ reason })` for a reply it cannot read: `app.resume` then
 * throws `UninterpretableReplyError` with that reason and the pause stays pending. A `throw` is an
 * unexpected crash only (the same error, its `cause` the thrown one).
 */
export interface ReplyInterpreterHandler<TSelf> {
  readonly interpret: (
    input: InputOf<TSelf>,
  ) => ReplyInterpretation<OutputOf<TSelf>> | Promise<ReplyInterpretation<OutputOf<TSelf>>>;
}

const interpreters = new WeakMap<Class, ReplyInterpreterDeclaration>();

/** The decorator of an interpreter; a code interpreter's constructor takes its `deps`. */
export type ReplyInterpreterDecorator<TDeps extends readonly Token[]> = <
  TClass extends new (...args: ResolvedAll<TDeps>) => object,
>(
  value: TClass,
) => TClass;

/** An interpreter its chat model decides (`DecidedBy.Model`). */
export function ReplyInterpreter(
  options: ModelReplyInterpreterOptions,
): ReplyInterpreterDecorator<[]>;
/** An interpreter its class decides (`DecidedBy.Code`): `interpret(input)`, `deps` in its constructor. */
export function ReplyInterpreter<const TDeps extends readonly Token[] = []>(
  options: CodeReplyInterpreterOptions<TDeps>,
): ReplyInterpreterDecorator<TDeps>;
export function ReplyInterpreter(
  options: ReplyInterpreterOptions,
): <TClass extends Class>(value: TClass) => TClass {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    const named = { ...options, name: resolvedName(options.name, value) };
    interpreters.set(value, source === undefined ? { options: named } : { options: named, source });
    return value;
  };
}

/** Records an interpreter the other decorator declares (`@ChannelInterpreter`, #1310c). */
export function recordInterpreter(value: Class, declaration: ReplyInterpreterDeclaration): void {
  interpreters.set(value, declaration);
}

/** What `@ReplyInterpreter` recorded on a class; `undefined` for an undecorated one. */
export const replyInterpreterOf = (cls: Class): ReplyInterpreterDeclaration | undefined =>
  interpreters.get(cls);

/** Whether an interpreter is decided by code. */
export const isCodeReplyInterpreter = (
  options: ReplyInterpreterOptions,
): options is CodeReplyInterpreterOptions => options.decidedBy === DecidedBy.Code;
