import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { DecidedBy } from "../flow/decorators/router.js";
import type { InputOf, OutputOf } from "../flow/generated-types.js";
import { NodeKind } from "../flow/ast.js";
import { declared, recordDeclaration } from "../flow/decorators/declaration.js";

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

/** What every channel role declares. */
export interface ChannelRoleBaseOptions {
  /** Kebab-case, unique in the application (`refund-approval-channel`). */
  readonly name: string;
  readonly description: string;
  /** Who may answer its pauses — required (this, or its 0.1.0 spelling `answeredBy`). */
  readonly answerer?: PauseAnswerer;
  /** @deprecated 0.1.0's spelling of `answerer`, kept until 0.2: use `answerer`. */
  readonly answeredBy?: PauseAnswerer;
  /** Who turns a free-text reply into the role's typed answer; one interpreter belongs to one role. */
  readonly replyInterpreter?: Class;
}

/** A tool approval: the question is the tool call, its `arguments` typed by `approves`. */
export interface ChannelApprovalRoleOptions extends ChannelRoleBaseOptions {
  /** The input DTO of the tools the role approves (`[channel.wrong-tool]` for any other tool). */
  readonly approves: DtoClass;
  readonly ask?: never;
  readonly answer?: never;
  readonly maxVisits?: never;
}

/**
 * A workflow question (#659): asked by a flow step, `.toQuestion(Role)` — the role is that step's
 * node (its `name` ends with `-question`). The step reads one `ask` value from the path, pauses on
 * the role's channel and puts the `answer` on the path (`.returns(AnswerDto)`).
 */
export interface ChannelQuestionRoleOptions extends ChannelRoleBaseOptions {
  /** What is asked: the step reads one value of this class from the path (its field `question`). */
  readonly ask: DtoClass;
  /** What answers it: a `decision`, a channel's `decided(…)`, or a reply's interpreted answer. */
  readonly answer: DtoClass;
  /** How many times the step may be visited in one execution (required on a cycle). */
  readonly maxVisits?: number;
  readonly approves?: never;
}

/** The two forms of a role, never both. */
export type ChannelRoleForm = ChannelApprovalRoleOptions | ChannelQuestionRoleOptions;

/** What `@ChannelRole({ … })` takes: a form, and who may answer as `answerer` (or `answeredBy`). */
export type ChannelRoleOptions = (ChannelApprovalRoleOptions | ChannelQuestionRoleOptions) &
  // `answeredBy` is the base's property, `@deprecated` there and here (it is the same declaration)
  ({ readonly answerer: PauseAnswerer } | Required<Pick<ChannelRoleBaseOptions, "answeredBy">>);

/** A role as it is kept: its options with `answerer` settled, whichever spelling was given. */
export type StoredChannelRole = ChannelRoleForm & { readonly answerer: PauseAnswerer };

/** Whether a role asks a workflow question (`ask` / `answer`, #659) rather than approving a tool. */
export const isQuestionRole = (options: ChannelRoleForm): options is ChannelQuestionRoleOptions =>
  options.approves === undefined;

const roles = new WeakMap<Class, StoredChannelRole>();

const PAUSE_ANSWERERS: ReadonlySet<string> = new Set(Object.values(PauseAnswerer));

const isAnswerer = (value: unknown): value is PauseAnswerer => PAUSE_ANSWERERS.has(String(value));

const CONFLICT =
  "gives answerer and answeredBy (its 0.1.0 spelling) different values — keep answerer";
const MISSING =
  "has no answerer — say who may answer: PauseAnswerer.ThreadOwner or PauseAnswerer.Channel";

type RoleFields = Partial<
  Record<"approves" | "ask" | "answer" | "answerer" | "answeredBy", unknown>
>;

/** The form problem of a role's options (both forms, neither); none → `undefined`. */
function formProblem(fields: RoleFields): string | undefined {
  const isApproval = fields.approves !== undefined;
  const isQuestion = fields.ask !== undefined || fields.answer !== undefined;
  if (isApproval && isQuestion) return "declares both approves and ask / answer — keep one form";
  if (!isApproval && (fields.ask === undefined || fields.answer === undefined))
    return "declares neither approves nor both ask and answer";
  return undefined;
}

/** What a role's options declare: a problem with them, or who may answer (`answerer` or its alias). */
type Declared = { readonly problem: string } | { readonly answerer: PauseAnswerer };

function declaredOf(options: ChannelRoleOptions): Declared {
  // read as an untyped (JS) caller may pass them: the types rule these forms out already
  const fields: RoleFields = options;
  const problem = formProblem(fields);
  if (problem !== undefined) return { problem };
  const { answerer, answeredBy } = fields;
  if (answerer !== undefined && answeredBy !== undefined && answerer !== answeredBy)
    return { problem: CONFLICT };
  const declared = answerer ?? answeredBy;
  if (!isAnswerer(declared)) return { problem: MISSING };
  return { answerer: declared };
}

/**
 * What a question role's step is as a flow node (#659): its role's name and description, one
 * input field `ask` of the `ask` class (#802: one name for the value), the `answer` as its output,
 * its `maxVisits`. The flow's own record, not part of the public surface.
 */
export interface QuestionNodeOptions {
  readonly name: string;
  readonly description: string;
  readonly input: { readonly ask: DtoClass };
  readonly output: DtoClass;
  readonly maxVisits?: number;
  /** The role's own options. */
  readonly role: ChannelQuestionRoleOptions;
}

export function ChannelRole(options: ChannelRoleOptions) {
  const source = callerFile();
  return <TClass extends Class>(value: TClass): TClass => {
    const declared = declaredOf(options);
    if ("problem" in declared) {
      throw new ComponentError({
        message: `[channel.role-form] @ChannelRole "${options.name}" (${value.name}) ${declared.problem}`,
      });
    }
    roles.set(value, { ...options, answerer: declared.answerer });
    if (isQuestionRole(options)) recordDeclaration(value, questionDeclarationOf(options, source));
    return value;
  };
}

/** The node a question role's step is (#659). */
function questionDeclarationOf(options: ChannelQuestionRoleOptions, source: string | undefined) {
  const { name, description, ask, answer, maxVisits } = options;
  const node: QuestionNodeOptions = {
    name,
    description,
    input: { ask },
    output: answer,
    ...(maxVisits === undefined ? {} : { maxVisits }),
    role: options,
  };
  return declared(NodeKind.Question, node, source);
}

/** The options `@ChannelRole` recorded on this very class; `undefined` for any other class. */
export const channelRoleOptionsOf = (cls: Class): StoredChannelRole | undefined => roles.get(cls);

/** A role class and its options. */
export interface FoundChannelRole {
  readonly role: Class;
  readonly options: StoredChannelRole;
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
 * (an approval role's only, `[reply-interpreter.decision-model]` for a question role) through one `Decision.noul("approved")` (static `prompt` / `promptUrls`;
 * `ask` and `reply` come in the input message); `DecidedBy.Code` — the class's `interpret(input)`
 * (`implements ReplyInterpreterHandler<Self>`), returning a `ReplyInterpretation`. Code downstream
 * decides by types, never by text.
 */

/** `@ReplyInterpreter({ decidedBy: DecidedBy.Model })`: one answer tool on a chat model. */
export interface ModelReplyInterpreterOptions {
  /** Kebab-case, ends with `-reply-interpreter` (`refund-reply-interpreter`). */
  readonly name: string;
  readonly description: string;
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
export interface CodeReplyInterpreterOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case, ends with `-reply-interpreter` (`refund-reply-interpreter`). */
  readonly name: string;
  readonly description: string;
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
