import { callerFile } from "../components/call-site.js";
import { AGBossError } from "../core/errors.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { DecidedBy } from "../flow/decorators/router.js";
import type { InputOf, OutputOf } from "../flow/generated-types.js";

/**
 * `@ReplyInterpreter` (#267 PR 3): who turns a free-text reply to a pause into its role's typed
 * answer — named on the role (`@ChannelRole({ replyInterpreter })`), one interpreter per role. It gets
 * the pause's original question and the reply (`{ ask, reply }`); what it returns is validated like
 * any decision. `DecidedBy.Model` — its chat model answers through one answer tool (static `prompt` /
 * `promptUrls`; `ask` and `reply` come in the input message); `DecidedBy.Code` — the class's
 * `interpret(input)` (`implements ReplyInterpreterHandler<Self>`). Code downstream decides by types,
 * never by text.
 */

/** What every reply interpreter declares. */
interface ReplyInterpreterBaseOptions {
  /** Kebab-case, ends with `-reply-interpreter` (`refund-reply-interpreter`). */
  readonly name: string;
  readonly description: string;
}

/** `@ReplyInterpreter({ decidedBy: DecidedBy.Model })`: one answer tool on a chat model. */
export interface ModelReplyInterpreterOptions extends ReplyInterpreterBaseOptions {
  readonly decidedBy: DecidedBy.Model;
  /** A chat model (a decision model cannot give a typed answer: `[reply-interpreter.decision-model]`). */
  readonly model: string;
  /** How to read a reply; static — the question and the reply come in the input message. */
  readonly prompt?: string;
  readonly promptUrls?: readonly string[];
  readonly deps?: never;
}

/** `@ReplyInterpreter({ decidedBy: DecidedBy.Code })`: the class's `interpret(input)`. */
export interface CodeReplyInterpreterOptions<
  TDeps extends readonly Token[] = readonly Token[],
> extends ReplyInterpreterBaseOptions {
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
  readonly options: ReplyInterpreterOptions;
  readonly source?: string;
}

/**
 * A code interpreter's contract: `interpret({ ask, reply })` returns the role's answer —
 * `InputOf<Self>` / `OutputOf<Self>` from the generated types. It declines a reply it cannot read
 * by throwing: `app.resume` then throws `UninterpretableReplyError` and the pause stays pending.
 */
export interface ReplyInterpreterHandler<TSelf> {
  interpret(input: InputOf<TSelf>): Promise<OutputOf<TSelf>>;
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
    interpreters.set(value, source === undefined ? { options } : { options, source });
    return value;
  };
}

/** What `@ReplyInterpreter` recorded on a class; `undefined` for an undecorated one. */
export const replyInterpreterOf = (cls: Class): ReplyInterpreterDeclaration | undefined =>
  interpreters.get(cls);

/** Whether an interpreter is decided by code. */
export const isCodeReplyInterpreter = (
  options: ReplyInterpreterOptions,
): options is CodeReplyInterpreterOptions => options.decidedBy === DecidedBy.Code;

/**
 * Why a free-text reply did not answer its pause (#267 PR 3). Both leave the pause `Pending`: the
 * webhook may ask for a clearer answer, or answer with a typed `decision`.
 */

/**
 * The role's reply interpreter could not read the reply as a valid answer: it declined (a code
 * interpreter threw, a model gave no answer) or its answer is not valid for the role (`cause`).
 */
export class UninterpretableReplyError extends AGBossError {
  static override readonly code: string = "pause.uninterpretable-reply";
  override name = "UninterpretableReplyError";
}

/** A `reply` for a pause whose role declares no `replyInterpreter`: answer it with a `decision`. */
export class ReplyInterpreterMissingError extends AGBossError {
  static override readonly code: string = "pause.no-reply-interpreter";
  override name = "ReplyInterpreterMissingError";
}
