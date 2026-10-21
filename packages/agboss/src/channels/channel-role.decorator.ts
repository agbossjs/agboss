import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import { AGBossError } from "../core/errors.js";
import type { DtoClass } from "../dto/types.js";
import { DecidedBy } from "../flow/decorators/router.js";
import type { InputOf, OutputOf } from "../flow/generated-types.js";

/**
 * `@ChannelRole` (#267): a project's abstract channel class — what a pause asks and who may answer
 * it. A tool names the role (`@Tool({ channel: RefundApprovalChannel })`); the application provides
 * its one implementation in `@Application({ providers })`, found by inheritance.
 */

/** Who may answer a pause of a role: required on every role, no default (#267 AC4). */
export enum PauseAnswerer {
  /** The thread's owner (`resume` checks its `ownerId`): a workflow question to the customer. */
  ThreadOwner = "thread-owner",
  /** The channel's side authenticates who answers (Slack, a ticket system, an admin panel). */
  Channel = "channel",
}

/** What every channel role declares, whichever its form (`approves` or `ask` / `answer`). */
export interface ChannelRoleBaseOptions {
  /** Kebab-case, unique in the application (`refund-approval-channel`). */
  readonly name: string;
  readonly description: string;
  /** Who may answer its pauses — required. */
  readonly answeredBy: PauseAnswerer;
  /** Who turns a free-text reply into the role's typed answer; one interpreter belongs to one role. */
  readonly replyInterpreter?: Class;
}

/** A tool approval: the question is the tool call, its `arguments` typed by `approves`. */
export interface ChannelApprovalRoleOptions extends ChannelRoleBaseOptions {
  /** The input DTO of the tools the role approves (`[channel.wrong-tool]` for any other tool). */
  readonly approves: DtoClass;
  readonly ask?: never;
  readonly answer?: never;
}

/** A workflow question: the project's own question and answer DTOs. */
export interface ChannelQuestionRoleOptions extends ChannelRoleBaseOptions {
  readonly ask: DtoClass;
  readonly answer: DtoClass;
  readonly approves?: never;
}

/** The two forms of a role, never both. */
export type ChannelRoleOptions = ChannelApprovalRoleOptions | ChannelQuestionRoleOptions;

const roles = new WeakMap<Class, ChannelRoleOptions>();

const PAUSE_ANSWERERS: ReadonlySet<string> = new Set(Object.values(PauseAnswerer));

/** The form problem of a role's options (both forms, neither, no `answeredBy`); none → `undefined`. */
function formProblem(options: ChannelRoleOptions): string | undefined {
  // read as an untyped (JS) caller may pass them: the types rule these forms out already
  const fields: Partial<Record<"approves" | "ask" | "answer" | "answeredBy", unknown>> = options;
  const isApproval = fields.approves !== undefined;
  const isQuestion = fields.ask !== undefined || fields.answer !== undefined;
  if (isApproval && isQuestion) return "declares both approves and ask / answer — keep one form";
  if (!isApproval && (fields.ask === undefined || fields.answer === undefined))
    return "declares neither approves nor both ask and answer";
  if (typeof fields.answeredBy !== "string" || !PAUSE_ANSWERERS.has(fields.answeredBy))
    return "has no answeredBy — say who may answer: PauseAnswerer.ThreadOwner or PauseAnswerer.Channel";
  return undefined;
}

export function ChannelRole(options: ChannelRoleOptions) {
  return <TClass extends Class>(value: TClass): TClass => {
    const problem = formProblem(options);
    if (problem !== undefined) {
      throw new ComponentError(
        `[channel.role-form] @ChannelRole "${options.name}" (${value.name}) ${problem}`,
      );
    }
    roles.set(value, options);
    return value;
  };
}

/** The options `@ChannelRole` recorded on this very class; `undefined` for any other class. */
export const channelRoleOptionsOf = (cls: Class): ChannelRoleOptions | undefined => roles.get(cls);

/** A role class and its options. */
export interface FoundChannelRole {
  readonly role: Class;
  readonly options: ChannelRoleOptions;
}

/** The role a channel class is or extends (the nearest one); `undefined` for a role-less channel. */
export function channelRoleOf(cls: Class): FoundChannelRole | undefined {
  for (let current: unknown = cls; typeof current === "function";) {
    const options = roles.get(current as Class);
    if (options !== undefined) return { role: current as Class, options };
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

/**
 * `@ReplyInterpreter` (#267 PR 3): who turns a free-text reply to a pause into its role's typed
 * answer — named on the role (`@ChannelRole({ replyInterpreter })`), one interpreter per role. It gets
 * the pause's original question and the reply (`{ ask, reply }`); what it returns is validated like
 * any decision. `DecidedBy.Model` — its chat model answers through one answer tool, a decision model
 * (an approval role's only) through one `Decision.noul("approved")` (static `prompt` / `promptUrls`;
 * `ask` and `reply` come in the input message); `DecidedBy.Code` — the class's `interpret(input)`
 * (`implements ReplyInterpreterHandler<Self>`), returning a `ReplyInterpretation`. Code downstream
 * decides by types, never by text.
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
  /**
   * A chat model (one answer tool), or — for an approval role only — a decision model (one
   * `Decision.noul("approved")`: approve / refuse, no `reason`, no `overrideArguments`, #267 S124 a);
   * a decision model for a question role is `[reply-interpreter.decision-model]`.
   */
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

/** The two outcomes of a code interpreter's `interpret` (#267 S124 b). */
export enum ReplyInterpretationKind {
  /** The reply was read: its decision is validated like any other. */
  Understood = "understood",
  /** The reply says nothing the interpreter can read: the pause stays pending. */
  NotUnderstood = "not-understood",
}

declare const replyInterpretation: unique symbol;

/** Only `ReplyInterpretation.understood(…)` / `.notUnderstood(…)` build one (a plain object does not compile). */
interface BuiltReplyInterpretation {
  readonly [replyInterpretation]: true;
}

/** The reply was read as `decision`. */
export interface UnderstoodReply<TDecision> extends BuiltReplyInterpretation {
  readonly kind: ReplyInterpretationKind.Understood;
  readonly decision: TDecision;
}

/** The reply was not understood: `reason` is the `UninterpretableReplyError`'s. */
export interface NotUnderstoodReply extends BuiltReplyInterpretation {
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

/** `new UninterpretableReplyError(message, { reason, cause? })`. */
export interface UninterpretableReplyErrorOptions {
  readonly reason: string;
  readonly cause?: unknown;
}

/**
 * The role's reply interpreter could not read the reply as a valid answer: a code interpreter's
 * `ReplyInterpretation.notUnderstood({ reason })`, a model that gave no answer, an answer not valid
 * for the role (`cause`) or an interpreter that crashed (`cause`, #267 S124 b). `reason` says why.
 */
export class UninterpretableReplyError extends AGBossError {
  static override readonly code: string = "pause.uninterpretable-reply";
  override name = "UninterpretableReplyError";
  /** Why the reply was not read: the interpreter's own reason, or its error's message. */
  readonly reason: string;

  constructor(message: string, options: UninterpretableReplyErrorOptions) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.reason = options.reason;
  }
}

/** A `reply` for a pause whose role declares no `replyInterpreter`: answer it with a `decision`. */
export class ReplyInterpreterMissingError extends AGBossError {
  static override readonly code: string = "pause.no-reply-interpreter";
  override name = "ReplyInterpreterMissingError";
}
