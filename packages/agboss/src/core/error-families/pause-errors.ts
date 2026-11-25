import type { ExpiryProblem, PauseClosedReason } from "../../infrastructure/pause-record.js";
import type { WorkingCalendarProblem } from "../../calendar/working-calendar.js";
import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import {
  closedMessageOf,
  expiryHandlerFailedMessageOf,
  updateContendedMessageOf,
  workingCalendarMessageOf,
} from "./pause-error-messages.js";

/** The kinds of `PauseError`: `switch (error.kind)` is exhaustive. */
export enum PauseErrorKind {
  NotPaused = "not-paused",
  UnknownPause = "unknown-pause",
  Closed = "closed",
  WrongRespondent = "wrong-respondent",
  PermissionDenied = "permission-denied",
  EscalationLimitExceeded = "escalation-limit-exceeded",
  IncompatibleTarget = "incompatible-target",
  UninterpretableReply = "uninterpretable-reply",
  ChannelInterpreterMissing = "channel-interpreter-missing",
  ExpiryHandlerFailed = "expiry-handler-failed",
  WorkingCalendar = "working-calendar",
  UpdateContended = "update-contended",
  StepKeyMismatch = "step-key-mismatch",
  InvalidTimeout = "invalid-timeout",
}

/** A pause could not be answered, reassigned, extended or expired the way the caller asked. */
export type PauseError =
  | PauseError.NotPaused
  | PauseError.UnknownPause
  | PauseError.Closed
  | PauseError.WrongRespondent
  | PauseError.PermissionDenied
  | PauseError.EscalationLimitExceeded
  | PauseError.IncompatibleTarget
  | PauseError.UninterpretableReply
  | PauseError.ChannelInterpreterMissing
  | PauseError.ExpiryHandlerFailed
  | PauseError.WorkingCalendar
  | PauseError.UpdateContended
  | PauseError.StepKeyMismatch
  | PauseError.InvalidTimeout;

/** The variants of `PauseError`, each with the facts it carries. */
export declare namespace PauseError {
  /** The thread is not paused. */
  export type NotPaused = ErrorVariant<PauseErrorKind.NotPaused, "pause.not-paused">;
  /** No such pause. */
  export type UnknownPause = ErrorVariant<PauseErrorKind.UnknownPause, "pause.unknown-pause">;
  /** The pause was closed before the answer came. */
  export type Closed = ErrorVariant<PauseErrorKind.Closed, "pause.closed"> & {
    /** The pause the caller answered: the id they passed. Never in `details`: a pause id is a credential. */
    readonly pauseId: string;
    /** The tenant that has the pause: with the id it makes the `pauseKey` the message names. */
    readonly tenantId: string;
    readonly reason: PauseClosedReason;
    /** When it closed (ISO 8601). */
    readonly closedAt: string;
  };
  /** The answer came from someone the pause does not wait for. */
  export type WrongRespondent = ErrorVariant<
    PauseErrorKind.WrongRespondent,
    "pause.wrong-respondent"
  >;
  /** The caller may not answer this pause. */
  export type PermissionDenied = ErrorVariant<
    PauseErrorKind.PermissionDenied,
    "pause.permission-denied"
  >;
  /** The pause was escalated as often as it may be. */
  export type EscalationLimitExceeded = ErrorVariant<
    PauseErrorKind.EscalationLimitExceeded,
    "pause.escalation-limit-exceeded"
  >;
  /** The new target of a pause does not fit its kind or DTO. */
  export type IncompatibleTarget = ErrorVariant<
    PauseErrorKind.IncompatibleTarget,
    "pause.incompatible-target"
  >;
  /** A reply could not be read as an answer. */
  export type UninterpretableReply = ErrorVariant<
    PauseErrorKind.UninterpretableReply,
    "pause.uninterpretable-reply"
  > & {
    /** Why the reply was not read: the interpreter's own reason, or its error's message. */
    readonly reason?: string | undefined;
  };
  /** The channel has no reply interpreter. */
  export type ChannelInterpreterMissing = ErrorVariant<
    PauseErrorKind.ChannelInterpreterMissing,
    "pause.channel-interpreter-missing"
  > & { readonly channel?: string | undefined };
  /** A pause's expiry handler failed. */
  export type ExpiryHandlerFailed = ErrorVariant<
    PauseErrorKind.ExpiryHandlerFailed,
    "pause.expiry-handler-failed"
  > & { readonly channel: string; readonly problem: ExpiryProblem };
  /** A working-calendar deadline cannot be computed. */
  export type WorkingCalendar = ErrorVariant<
    PauseErrorKind.WorkingCalendar,
    "pause.working-calendar"
  > & {
    readonly calendar?: string | undefined;
    readonly problem?: WorkingCalendarProblem | undefined;
  };
  /** Two updates of one pause raced. */
  export type UpdateContended = ErrorVariant<
    PauseErrorKind.UpdateContended,
    "pause.update-contended"
  > & {
    /** The pause's `pauseKey` (a message is logged and observed: never its bare id). */
    readonly pauseKey?: string | undefined;
    /** How many times the call read and tried. */
    readonly attempts?: number | undefined;
  };
  /** An answer is for another step than the pause's. */
  export type StepKeyMismatch = ErrorVariant<
    PauseErrorKind.StepKeyMismatch,
    "pause.step-key-mismatch"
  >;
  /** A pause's timeout is not a valid duration. */
  export type InvalidTimeout = ErrorVariant<PauseErrorKind.InvalidTimeout, "pause.invalid-timeout">;
}

/** `PauseError`: the family's constructor and its variants'. */
export const PauseError: FamilyConstructor<
  PauseError,
  {
    NotPaused: PauseError.NotPaused;
    UnknownPause: PauseError.UnknownPause;
    Closed: PauseError.Closed;
    WrongRespondent: PauseError.WrongRespondent;
    PermissionDenied: PauseError.PermissionDenied;
    EscalationLimitExceeded: PauseError.EscalationLimitExceeded;
    IncompatibleTarget: PauseError.IncompatibleTarget;
    UninterpretableReply: PauseError.UninterpretableReply;
    ChannelInterpreterMissing: PauseError.ChannelInterpreterMissing;
    ExpiryHandlerFailed: PauseError.ExpiryHandlerFailed;
    WorkingCalendar: PauseError.WorkingCalendar;
    UpdateContended: PauseError.UpdateContended;
    StepKeyMismatch: PauseError.StepKeyMismatch;
    InvalidTimeout: PauseError.InvalidTimeout;
  }
> = defineFamily({
  name: "PauseError",
  code: "pause",
  kinds: PauseErrorKind,
  variants: {
    NotPaused: ["the thread is not paused"],
    UnknownPause: ["no such pause"],
    Closed: [closedMessageOf, undefined, { hidden: ["pauseId", "tenantId"] }],
    WrongRespondent: ["the answer came from someone the pause does not wait for"],
    PermissionDenied: ["the caller may not answer this pause"],
    EscalationLimitExceeded: ["the pause was escalated as often as it may be"],
    IncompatibleTarget: ["the new target of a pause does not fit its kind or DTO"],
    UninterpretableReply: ["a reply could not be read as an answer"],
    ChannelInterpreterMissing: ["the channel has no reply interpreter"],
    ExpiryHandlerFailed: [expiryHandlerFailedMessageOf],
    WorkingCalendar: [workingCalendarMessageOf],
    UpdateContended: [updateContendedMessageOf],
    StepKeyMismatch: ["an answer is for another step than the pause's"],
    InvalidTimeout: ["a pause's timeout is not a valid duration"],
  },
});
