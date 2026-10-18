import type { Class } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";

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

/** What every role declares. */
interface ChannelRoleBaseOptions {
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
