import type { PauseRespondent } from "../../pause/respondent.js";
import type {
  PauseEscalationLimits,
  PermitAnswer,
  PermitReassign,
  PermitTimeoutChange,
} from "../../channels/pause-contexts.js";
import type { ChannelSender } from "../../channels/channel-sender.js";
import type { PauseCalendar } from "../../calendar/calendar-call.js";
import { seconds, type Milliseconds, type WorkingDuration } from "../../units/index.js";
import type { Class } from "../../components/injection.js";
import type { PauseTrailRecord } from "../../infrastructure/pause-record.js";

/** A channel as a pause asks it: the transport of one pause target (#1307). */
export interface PauseChannel {
  /** The `@Channel`'s name: what a pause record names as its `channel`. */
  readonly name: string;
  readonly sender: ChannelSender;
  /** The class, as a `@ChannelSelector` names it and `app.reassignPause({ channel })` takes it. */
  readonly cls: Class;
  /** How long one `send` may take (`@Channel({ timeout })`); `DEFAULT_CHANNEL_TIMEOUT` when left out. */
  readonly timeout?: Milliseconds | undefined;
}

/** How long a channel's `send` may take when its `@Channel` says nothing. */
export const DEFAULT_CHANNEL_TIMEOUT: Milliseconds = seconds(30);

/** What a `@ChannelSelector` is asked: the target's pause so far, as the selector's context reads it. */
export type SelectChannel = (ctx: never) => Promise<Class>;

/**
 * A pause target as a pause asks it (#1307): who may answer its pauses, how long they wait, its
 * hooks bound to its one instance, and the channels that carry it — none for an owner's target.
 */
export interface PauseTarget {
  /** The target's name: what a pause record names as its `target`. */
  readonly name: string;
  readonly cls: Class;
  readonly kind: "tool-approval" | "external-task";
  readonly respondent: PauseRespondent;
  /** The channels serving it, by name; empty for an owner's target with none. */
  readonly channels: ReadonlyMap<string, PauseChannel>;
  /** Picks one of several channels (a `@ChannelSelector` of this target); absent: the only one. */
  readonly select?: SelectChannel | undefined;
  /** How long its pauses wait for an answer (#941): its `timeout`, or the profile's over it. */
  readonly timeout?: Milliseconds | WorkingDuration | undefined;
  /** How long before its deadline its pauses are reminded (#942): none → no reminder. */
  readonly remindBefore?: Milliseconds | WorkingDuration | undefined;
  /** The calendar that counts its working time (#944); none → no working time. */
  readonly calendar?: PauseCalendar | undefined;
  readonly escalationLimits?: PauseEscalationLimits | undefined;
  /** The target's `permitAnswer` (#1307c): anything but `true` refuses an answer; `undefined`: none. */
  readonly permitAnswer?: PermitAnswer | undefined;
  /** The target's `permitTimeoutChange` (#1307): anything but `true` refuses a timeout change; `undefined`: none. */
  readonly permitTimeoutChange?: PermitTimeoutChange | undefined;
  /** The target's `permitReassign` (#1307d): anything but `true` refuses a reassignment; `undefined`: none. */
  readonly permitReassign?: PermitReassign | undefined;
  /** The target's `assign`: who a new pause is for; `undefined`: nobody in particular (or no hook). */
  readonly assign?: AssignHook | undefined;
  /** The target's `resolveTimeout`: this pause's wait, over the declared `timeout`; `undefined`: none. */
  readonly resolveTimeout?: ResolveTimeoutHook | undefined;
  /** The target's `onExpired`: what the expiry of its pauses means; `undefined`: `PauseExpiration.fail()`. */
  readonly onExpired?: ExpiredHook | undefined;
  /** The `escalatesTo` targets' names: where an expiry or an operator may move its pauses to. */
  readonly escalatesTo?: readonly string[] | undefined;
}

/** A target's `assign` as the runtime calls it. */
export type AssignHook = (ctx: never) => Promise<readonly string[] | undefined>;
/** A target's `resolveTimeout` as the runtime calls it. */
export type ResolveTimeoutHook = (
  ctx: never,
) => Promise<Milliseconds | WorkingDuration | undefined>;
/** A target's `onExpired` as the runtime calls it. */
export type ExpiredHook = (ctx: never) => Promise<unknown>;

/** What a `@ChannelSelector` reads of a pause about to be sent: its deadline and chain of custody so far. */
export interface PendingOpening {
  readonly expiresAt?: Date;
  /** Who the pause is for, from the target's `assign`. */
  readonly assignees?: readonly string[];
  readonly trail: readonly PauseTrailRecord[];
}

/** Picks the channel a new pause is sent through (a target with several channels asks its selector). */
export type ChooseChannel = (opening: PendingOpening) => Promise<PauseChannel | undefined>;

/** The target's only channel (none for an owner's target): no selector is asked. */
export const onlyChannelOf =
  (target: PauseTarget): ChooseChannel =>
  () =>
    Promise.resolve([...target.channels.values()][0]);
