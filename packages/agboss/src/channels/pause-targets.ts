import { recordOptionKeys } from "../components/option-keys.js";
import { EXTERNAL_TASK_KEYS, TOOL_APPROVAL_KEYS } from "../components/decorator-options.js";
import { callerFile } from "../components/call-site.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import type { DtoClass } from "../dto/types.js";
import type { Milliseconds, WorkingDuration } from "../units/index.js";
import { PauseAnswerer, recordRole, type StoredChannelRole } from "./channel-role.decorator.js";
import type { WorkingCalendarSource } from "../calendar/working-calendar.js";
import type { PauseEscalationLimits } from "./pause-contexts.js";
import { ComponentError, componentOf } from "../components/metadata.js";
import type { ProviderModule } from "../components/container/registrations.js";

/**
 * The pause targets (#1307a): `@ToolApproval` (what a `@Tool({ approval })` waits for) and
 * `@ExternalTask` (what a `.toExternalTask(Task)` step waits for) — the domain half of what
 * `@ChannelRole` declared, the transport half being `@Channel({ target })`. They record into the
 * registry `@ChannelRole` fills, so assembly and the runtime read one shape; what they add is
 * kept beside it (`pauseTargetOf`).
 */

/** Who may answer a pause of a target: required on every one, no default. */
export enum PauseRespondent {
  /** The thread's owner (`resume` checks its `ownerId`): a workflow question to the customer. */
  Owner = "owner",
  /** The channel's side authenticates who answers (Slack, a ticket system, an automation). */
  Delegate = "delegate",
}

/**
 * The optional hooks of a pause target, typed on what a class may declare without `implements`: a
 * hook's parameter is the target's own context (`AssignContext<Self>`), its result is checked here.
 */
export interface PauseTargetHooks {
  readonly assign?: (
    ctx: never,
  ) => readonly string[] | undefined | Promise<readonly string[] | undefined>;
  readonly resolveTimeout?: (
    ctx: never,
  ) =>
    | Milliseconds
    | WorkingDuration
    | undefined
    | Promise<Milliseconds | WorkingDuration | undefined>;
  readonly permitAnswer?: (ctx: never) => boolean | Promise<boolean>;
  readonly permitTimeoutChange?: (ctx: never) => boolean | Promise<boolean>;
  readonly permitReassign?: (ctx: never) => boolean | Promise<boolean>;
}

/** What `@ToolApproval` and `@ExternalTask` share. */
export interface PauseTargetBaseOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case, unique in the application, ending with the decorator's kind. */
  readonly name: string;
  readonly description: string;
  /** Who may answer its pauses — required, no default. */
  readonly respondent: PauseRespondent;
  /**
   * How long a pause of this target waits for its answer: `hours(24)`, `workHours(24)` (counted by
   * `calendar`). A positive finite duration of at least `seconds(1)`.
   */
  readonly timeout: Milliseconds | WorkingDuration;
  /** The `@WorkingCalendar` class that counts this target's working time. */
  readonly calendar?: Class;
  /** How long before its deadline the channel and the listeners are reminded. */
  readonly remindBefore?: Milliseconds | WorkingDuration;
  readonly escalationLimits?: PauseEscalationLimits;
  /** The targets an expiry or an operator may reassign its pauses to (owner-only ones need no channel). */
  readonly escalatesTo?: readonly Class[];
  /** The `@ChannelInterpreter` that turns a free-text reply into its output. */
  readonly channelInterpreter?: Class;
  /** Constructor dependencies, in order; checked against the constructor by the compiler. */
  readonly deps?: TDeps;
}

/**
 * `@ToolApproval({ … })`: the approval a `@Tool({ approval })` waits for. Its `input` is the DTO of
 * the tools it gates; left out, it gates any tool (the generated types give the union of their inputs).
 */
export interface ToolApprovalOptions<
  TDeps extends readonly Token[] = readonly Token[],
> extends PauseTargetBaseOptions<TDeps> {
  readonly input?: DtoClass;
  readonly output?: never;
  readonly maxVisits?: never;
}

/** `@ExternalTask({ … })`: what a `.toExternalTask(Task)` step (or an agent's tool) waits for. */
export interface ExternalTaskOptions<
  TDeps extends readonly Token[] = readonly Token[],
> extends PauseTargetBaseOptions<TDeps> {
  /** What is asked: the step reads one value of this class from the path. */
  readonly input: DtoClass;
  /** What answers it: a `decision`, a channel's `decided(…)`, or a reply's interpreted answer. */
  readonly output: DtoClass;
  /** How many times the step may be visited in one execution (required on a cycle). */
  readonly maxVisits?: number;
}

/** What a profile changes of one pause target (`toolApprovals` / `externalTasks`, by its name): how long its pauses wait. */
export interface PauseTargetOverlay {
  /** How long a pause of the target waits for its answer. */
  readonly timeout?: Milliseconds | WorkingDuration;
  /** How long before its deadline the channel and the listeners are reminded. */
  readonly remindBefore?: Milliseconds | WorkingDuration;
}

/** The overlays of the selected profiles by target `name`, the tool approvals' and the external tasks' together. */
export type PauseTargetOverrides = ReadonlyMap<string, PauseTargetOverlay>;

/** What a pause target recorded beside its role: its decorator and the options it was given. */
export type PauseTargetDeclaration =
  | { readonly kind: "tool-approval"; readonly options: ToolApprovalOptions }
  | { readonly kind: "external-task"; readonly options: ExternalTaskOptions };

const targets = new WeakMap<Class, PauseTargetDeclaration>();

/** What `@ToolApproval` / `@ExternalTask` recorded on this very class; `undefined` for any other. */
export const pauseTargetOf = (cls: Class): PauseTargetDeclaration | undefined => targets.get(cls);

const ANSWERERS: Readonly<Record<PauseRespondent, PauseAnswerer>> = {
  [PauseRespondent.Owner]: PauseAnswerer.ThreadOwner,
  [PauseRespondent.Delegate]: PauseAnswerer.Channel,
};

/** The options both decorators hand to the role registry, whatever the form. */
function roleBaseOf(options: PauseTargetBaseOptions) {
  const { name, description, respondent, timeout, calendar, remindBefore, channelInterpreter } =
    options;
  return {
    name,
    description,
    answerer: ANSWERERS[respondent],
    expiresIn: timeout,
    ...(remindBefore === undefined ? {} : { remindBefore }),
    ...(calendar === undefined ? {} : { workingCalendar: calendar as WorkingCalendarSource }),
    ...(channelInterpreter === undefined ? {} : { replyInterpreter: channelInterpreter }),
  };
}

/** `respondent` of an untyped (JS) caller: the types rule other values out already. */
function checkRespondent(decorator: string, name: string, respondent: unknown): void {
  if (respondent === PauseRespondent.Owner || respondent === PauseRespondent.Delegate) return;
  throw new ComponentError({
    message: `[pause-target.respondent] ${decorator} "${name}" has no respondent — say who may answer: PauseRespondent.Owner or PauseRespondent.Delegate`,
  });
}

/** A target class's decorator, as a message names it. */
const DECORATORS = { "tool-approval": "@ToolApproval", "external-task": "@ExternalTask" } as const;

/** The decorator of a class that is a pause target, as a message names it. */
export const targetDecoratorOf = (cls: Class): string | undefined => {
  const declaration = targets.get(cls);
  return declaration === undefined ? undefined : DECORATORS[declaration.kind];
};

/** A tool approval: one class, optional hooks, dependencies through the constructor. */
export function ToolApproval<const TDeps extends readonly Token[] = []>(
  options: ToolApprovalOptions<TDeps>,
) {
  const source = callerFile();
  return <TClass extends new (...args: ResolvedAll<TDeps>) => object & PauseTargetHooks>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "ToolApproval", options, TOOL_APPROVAL_KEYS);
    checkRespondent("@ToolApproval", options.name, options.respondent);
    // no `input`: the approval gates any tool
    const stored: StoredChannelRole =
      options.input === undefined
        ? { ...roleBaseOf(options), answerer: ANSWERERS[options.respondent] }
        : {
            ...roleBaseOf(options),
            approves: options.input,
            answerer: ANSWERERS[options.respondent],
          };
    recordRole(value, stored, source);
    targets.set(value, { kind: "tool-approval", options });
    return value;
  };
}

/** An external task: one class, optional hooks, dependencies through the constructor. */
export function ExternalTask<const TDeps extends readonly Token[] = []>(
  options: ExternalTaskOptions<TDeps>,
) {
  const source = callerFile();
  return <TClass extends new (...args: ResolvedAll<TDeps>) => object & PauseTargetHooks>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "ExternalTask", options, EXTERNAL_TASK_KEYS);
    checkRespondent("@ExternalTask", options.name, options.respondent);
    const stored: StoredChannelRole = {
      ...roleBaseOf(options),
      ask: options.input,
      answer: options.output,
      ...(options.maxVisits === undefined ? {} : { maxVisits: options.maxVisits }),
      answerer: ANSWERERS[options.respondent],
    };
    recordRole(value, stored, source);
    targets.set(value, { kind: "external-task", options });
    return value;
  };
}

/** The pause target a `@Channel({ target })` serves (#1307); `undefined` for any other class. */
export const channelTargetOf = (cls: Class): Class | undefined => {
  const component = componentOf(cls);
  return component?.kind === "channel" ? component.meta.target : undefined;
};

/** The classes the modules list as providers, each once. */
export const listedClassesOf = (modules: readonly ProviderModule[]): readonly Class[] => [
  ...new Set(
    modules.flatMap((module) =>
      module.providers.filter((provider): provider is Class => typeof provider === "function"),
    ),
  ),
];
