import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";

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
  export type UnknownPause = ErrorVariant<PauseErrorKind.UnknownPause, "pause.unknown">;
  /** The pause was closed before the answer came. */
  export type Closed = ErrorVariant<PauseErrorKind.Closed, "pause.closed"> & {
    readonly reason: string;
  };
  /** The answer came from someone the pause does not wait for. */
  export type WrongRespondent = ErrorVariant<
    PauseErrorKind.WrongRespondent,
    "pause.wrong-answerer"
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
  >;
  /** The channel has no reply interpreter. */
  export type ChannelInterpreterMissing = ErrorVariant<
    PauseErrorKind.ChannelInterpreterMissing,
    "pause.no-reply-interpreter"
  > & { readonly channel: string };
  /** A pause's expiry handler failed. */
  export type ExpiryHandlerFailed = ErrorVariant<
    PauseErrorKind.ExpiryHandlerFailed,
    "pause.expiry-handler"
  > & { readonly channel: string };
  /** A working-calendar deadline cannot be computed. */
  export type WorkingCalendar = ErrorVariant<
    PauseErrorKind.WorkingCalendar,
    "pause.working-calendar"
  >;
  /** Two updates of one pause raced. */
  export type UpdateContended = ErrorVariant<
    PauseErrorKind.UpdateContended,
    "pause.extension-contended"
  >;
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
    UnknownPause: ["no such pause", "pause.unknown"],
    Closed: ["the pause was closed before the answer came"],
    WrongRespondent: [
      "the answer came from someone the pause does not wait for",
      "pause.wrong-answerer",
    ],
    PermissionDenied: ["the caller may not answer this pause"],
    EscalationLimitExceeded: ["the pause was escalated as often as it may be"],
    IncompatibleTarget: ["the new target of a pause does not fit its kind or DTO"],
    UninterpretableReply: ["a reply could not be read as an answer"],
    ChannelInterpreterMissing: [
      "the channel has no reply interpreter",
      "pause.no-reply-interpreter",
    ],
    ExpiryHandlerFailed: ["a pause's expiry handler failed", "pause.expiry-handler"],
    WorkingCalendar: ["a working-calendar deadline cannot be computed"],
    UpdateContended: ["two updates of one pause raced", "pause.extension-contended"],
    StepKeyMismatch: ["an answer is for another step than the pause's"],
    InvalidTimeout: ["a pause's timeout is not a valid duration"],
  },
});
