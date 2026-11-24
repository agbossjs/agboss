import { recordOptionKeys } from "../components/option-keys.js";
import { CHANNEL_ROLE_KEYS } from "../components/decorator-options.js";
import { callerFile } from "../components/call-site.js";
import type { Class } from "../components/injection.js";
import { ComponentError } from "../components/metadata.js";
import type { DtoClass } from "../dto/types.js";
import { NodeKind } from "../flow/ast.js";
import { declared, recordDeclaration } from "../flow/decorators/declaration.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";
import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import { formProblem, type RoleFields } from "./channel-role-form.js";

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
  /**
   * How long a pause of this role waits for its answer (#941): `hours(24)`; at least `seconds(1)`;
   * `workingHours(2)` counts the calendar's working time (#944). The deadline is fixed when the pause is made (a deploy that changes this never moves an open
   * one); a question step (`.toExternalTask(Role, { expiresIn })`) and a tool (`@Tool({ expiresIn })`)
   * override it. None: the pause waits forever — or until its run's deadline.
   */
  readonly expiresIn?: Milliseconds | WorkingDuration;
  /**
   * How long before its deadline the channel and the listeners are reminded (#942): `hours(2)` —
   * they hear `onPauseExpiring` once, "expiring at …", again after an extension. A positive finite
   * duration shorter than this role's `expiresIn` (`[channel.remind-before-invalid]`) — in working
   * time (`workingHours(1)`) only with a working `expiresIn`
   * (`[channel.remind-before-working-without-working-expiry]`); a pause whose
   * step or tool gives it no more time than this gets no reminder
   * (`[channel.remind-before-exceeds-expiry]`, a warning). The reminder is fixed when the pause is
   * made and again by an extension. None: no reminder.
   */
  readonly remindBefore?: Milliseconds | WorkingDuration;
  /**
   * The calendar that counts this role's working time (#944): `WorkingWeek.of({ … })` or a
   * `@WorkingCalendar` class listed in `@Application({ providers })`, over the application's
   * `workingCalendar`. A working `expiresIn` or `remindBefore` here, on a step or on a tool needs
   * one (`[channel.working-time-without-calendar]`). A calendar changed later never moves an open pause.
   */
  readonly workingCalendar?: WorkingCalendarSource;
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
 * A workflow question (#659): asked by a flow step, `.toExternalTask(Role)` — the role is that step's
 * node (its `name` ends with `-question`). The step reads one `ask` value from the path, pauses on
 * the role's channel and puts the `answer` on the path (``).
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

/**
 * A tool approval with no `input` of its own (`@ToolApproval({ respondent, … })`, #1307): it approves
 * any tool that names it, whatever that tool's input is.
 */
export interface ChannelAnyToolApprovalOptions extends Omit<
  ChannelApprovalRoleOptions,
  "approves"
> {
  readonly approves?: undefined;
}

/** A role as it is kept: its options with `answerer` settled, whichever spelling was given. */
export type StoredChannelRole = (ChannelRoleForm | ChannelAnyToolApprovalOptions) & {
  readonly answerer: PauseAnswerer;
};

/** Whether a role asks a workflow question (`ask` / `answer`, #659) rather than approving a tool. */
export const isQuestionRole = (
  options: ChannelRoleForm | ChannelAnyToolApprovalOptions,
): options is ChannelQuestionRoleOptions => options.ask !== undefined;

const roles = new WeakMap<Class, StoredChannelRole>();

const PAUSE_ANSWERERS: ReadonlySet<string> = new Set(Object.values(PauseAnswerer));

const isAnswerer = (value: unknown): value is PauseAnswerer => PAUSE_ANSWERERS.has(String(value));

const CONFLICT =
  "gives answerer and answeredBy (its 0.1.0 spelling) different values — keep answerer";
const MISSING =
  "has no answerer — say who may answer: PauseAnswerer.ThreadOwner or PauseAnswerer.Channel";

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
    recordOptionKeys(value, "ChannelRole", options, CHANNEL_ROLE_KEYS);
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

/**
 * Records a role the other decorators declare (`@ToolApproval`, `@ExternalTask`, #1307): the same
 * registry `@ChannelRole` fills, so assembly and the runtime read one shape. A question form is
 * also its step's node.
 */
export function recordRole(
  value: Class,
  stored: StoredChannelRole,
  source: string | undefined,
): void {
  roles.set(value, stored);
  if (isQuestionRole(stored)) recordDeclaration(value, questionDeclarationOf(stored, source));
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

export * from "./reply-interpreter.decorator.js";
