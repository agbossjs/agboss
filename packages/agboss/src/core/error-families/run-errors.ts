import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { CancelFencedFacts } from "./run-error-facts.js";
import type { KeyTextRule } from "../key-text-rule.js";
import {
  cancelFencedMessageOf,
  compensationFailedMessageOf,
  duplicateExecutionIdMessageOf,
  incompatibleResumeMessageOf,
  invalidMintedIdMessageOf,
  invalidThreadIdMessageOf,
  threadIdsExhaustedMessageOf,
} from "./run-error-messages.js";
import type { CompensationRecord } from "../../flow/compensation.js";
import type { ResumeVersions } from "../../run/resume-guard.js";

/** The kinds of `ExecutionError`: `switch (error.kind)` is exhaustive. */
export enum ExecutionErrorKind {
  CancelFenced = "cancel-fenced",
  LeaseLost = "lease-lost",
  Fenced = "fenced",
  ExternallyPaused = "externally-paused",
  AlreadyTerminal = "already-terminal",
  IncompatibleResume = "incompatible-resume",
  UnknownThread = "unknown-thread",
  InvalidThreadId = "invalid-thread-id",
  InvalidMintedId = "invalid-minted-id",
  ThreadIdsExhausted = "thread-ids-exhausted",
  ThreadOwnerMismatch = "thread-owner-mismatch",
  DuplicateExecutionId = "duplicate-execution-id",
  ContextUnavailable = "context-unavailable",
  SpendOutsideStep = "spend-outside-step",
  ApplicationStopping = "application-stopping",
  CompensationFailed = "compensation-failed",
  OutputInvalid = "output-invalid",
  NothingToRecover = "nothing-to-recover",
  RemoteChildLost = "remote-child-lost",
}

/** An execution or a thread could not be started, continued or settled. `CancelFenced`, `LeaseLost` and `Fenced` are hand-overs: they reach no `.onError`. */
export type ExecutionError =
  | ExecutionError.CancelFenced
  | ExecutionError.LeaseLost
  | ExecutionError.Fenced
  | ExecutionError.ExternallyPaused
  | ExecutionError.AlreadyTerminal
  | ExecutionError.IncompatibleResume
  | ExecutionError.UnknownThread
  | ExecutionError.InvalidThreadId
  | ExecutionError.InvalidMintedId
  | ExecutionError.ThreadIdsExhausted
  | ExecutionError.ThreadOwnerMismatch
  | ExecutionError.DuplicateExecutionId
  | ExecutionError.ContextUnavailable
  | ExecutionError.SpendOutsideStep
  | ExecutionError.ApplicationStopping
  | ExecutionError.CompensationFailed
  | ExecutionError.OutputInvalid
  | ExecutionError.NothingToRecover
  | ExecutionError.RemoteChildLost;

/** The variants of `ExecutionError`, each with the facts it carries. */
export declare namespace ExecutionError {
  /** The execution was cancelled and its writes are fenced: a cancel, unwound under the lease the instance still holds — no hand-over. */
  export type CancelFenced = ErrorVariant<
    ExecutionErrorKind.CancelFenced,
    "execution.cancelled.fenced"
  > &
    CancelFencedFacts;
  /** The instance lost the lease of the tree it was moving. */
  export type LeaseLost = ErrorVariant<ExecutionErrorKind.LeaseLost, "execution.lease-lost"> & {
    readonly rootExecutionId: string;
  };
  /** An external system refused a write of this execution. */
  export type Fenced = ErrorVariant<ExecutionErrorKind.Fenced, "execution.lease-lost.fenced"> & {
    readonly scopeKey: string;
    readonly token: number;
    readonly observedToken?: number | undefined;
    readonly tenantId: string;
    readonly leaseExecutionId: string;
  };
  /** The execution is paused from outside. */
  export type ExternallyPaused = ErrorVariant<
    ExecutionErrorKind.ExternallyPaused,
    "execution.externally-paused"
  >;
  /** The execution already ended. */
  export type AlreadyTerminal = ErrorVariant<
    ExecutionErrorKind.AlreadyTerminal,
    "execution.already-terminal"
  >;
  /** The execution cannot be resumed by this version. */
  export type IncompatibleResume = ErrorVariant<
    ExecutionErrorKind.IncompatibleResume,
    "execution.incompatible-resume"
  > & {
    readonly threadId: string;
    readonly executionId: string;
    /** What the paused run was made under. */
    readonly paused: ResumeVersions;
    /** What this application runs. */
    readonly current: ResumeVersions;
  };
  /** No such thread. */
  export type UnknownThread = ErrorVariant<
    ExecutionErrorKind.UnknownThread,
    "execution.unknown-thread"
  >;
  /** The thread id is not a key. */
  export type InvalidThreadId = ErrorVariant<
    ExecutionErrorKind.InvalidThreadId,
    "execution.invalid-thread-id"
  > & { readonly rule: KeyTextRule };
  /** An id the IdGenerator minted is not a key. */
  export type InvalidMintedId = ErrorVariant<
    ExecutionErrorKind.InvalidMintedId,
    "execution.invalid-minted-id"
  > & {
    readonly generator: string;
    readonly method: "newThreadId" | "newExecutionId";
    readonly rule: KeyTextRule;
  };
  /** The IdGenerator minted only ids the tenant already has. */
  export type ThreadIdsExhausted = ErrorVariant<
    ExecutionErrorKind.ThreadIdsExhausted,
    "execution.thread-ids-exhausted"
  > & { readonly generator: string; readonly tries: number };
  /** The thread belongs to another owner. */
  export type ThreadOwnerMismatch = ErrorVariant<
    ExecutionErrorKind.ThreadOwnerMismatch,
    "execution.thread-owner-mismatch"
  >;
  /** The IdGenerator minted an execution id another execution already has. */
  export type DuplicateExecutionId = ErrorVariant<
    ExecutionErrorKind.DuplicateExecutionId,
    "execution.duplicate-execution-id"
  > & { readonly generator: string };
  /** There is no execution to read here. */
  export type ContextUnavailable = ErrorVariant<
    ExecutionErrorKind.ContextUnavailable,
    "execution.context-unavailable"
  >;
  /** Spend was recorded outside a step. */
  export type SpendOutsideStep = ErrorVariant<
    ExecutionErrorKind.SpendOutsideStep,
    "execution.spend-outside-step"
  >;
  /** The application is stopping and takes no new execution. */
  export type ApplicationStopping = ErrorVariant<
    ExecutionErrorKind.ApplicationStopping,
    "execution.application-stopping"
  >;
  /** An automatic undo failed. */
  export type CompensationFailed = ErrorVariant<
    ExecutionErrorKind.CompensationFailed,
    "execution.compensation-failed"
  > & {
    /** The undo actions that failed, newest first (each `CompensationStatus.Failed`). */
    readonly failures: readonly CompensationRecord[];
  };
  /** The execution's output is not what its finish declares. */
  export type OutputInvalid = ErrorVariant<
    ExecutionErrorKind.OutputInvalid,
    "execution.output-invalid"
  >;
  /** The run stored nothing to continue. */
  export type NothingToRecover = ErrorVariant<
    ExecutionErrorKind.NothingToRecover,
    "execution.nothing-to-recover"
  >;
  /** A remote child run was lost. */
  export type RemoteChildLost = ErrorVariant<
    ExecutionErrorKind.RemoteChildLost,
    "execution.remote-child-lost"
  >;
}

/** `ExecutionError`: the family's constructor and its variants'. */
export const ExecutionError: FamilyConstructor<
  ExecutionError,
  {
    CancelFenced: ExecutionError.CancelFenced;
    LeaseLost: ExecutionError.LeaseLost;
    Fenced: ExecutionError.Fenced;
    ExternallyPaused: ExecutionError.ExternallyPaused;
    AlreadyTerminal: ExecutionError.AlreadyTerminal;
    IncompatibleResume: ExecutionError.IncompatibleResume;
    UnknownThread: ExecutionError.UnknownThread;
    InvalidThreadId: ExecutionError.InvalidThreadId;
    InvalidMintedId: ExecutionError.InvalidMintedId;
    ThreadIdsExhausted: ExecutionError.ThreadIdsExhausted;
    ThreadOwnerMismatch: ExecutionError.ThreadOwnerMismatch;
    DuplicateExecutionId: ExecutionError.DuplicateExecutionId;
    ContextUnavailable: ExecutionError.ContextUnavailable;
    SpendOutsideStep: ExecutionError.SpendOutsideStep;
    ApplicationStopping: ExecutionError.ApplicationStopping;
    CompensationFailed: ExecutionError.CompensationFailed;
    OutputInvalid: ExecutionError.OutputInvalid;
    NothingToRecover: ExecutionError.NothingToRecover;
    RemoteChildLost: ExecutionError.RemoteChildLost;
  }
> = defineFamily({
  name: "ExecutionError",
  code: "execution",
  kinds: ExecutionErrorKind,
  variants: {
    CancelFenced: [cancelFencedMessageOf, "execution.cancelled.fenced"],
    LeaseLost: ["the instance lost the lease of the tree it was moving"],
    Fenced: ["an external system refused a write of this execution", "execution.lease-lost.fenced"],
    ExternallyPaused: ["the execution is paused from outside"],
    AlreadyTerminal: ["the execution already ended"],
    IncompatibleResume: [incompatibleResumeMessageOf],
    UnknownThread: ["no such thread"],
    InvalidThreadId: [invalidThreadIdMessageOf],
    InvalidMintedId: [invalidMintedIdMessageOf],
    ThreadIdsExhausted: [threadIdsExhaustedMessageOf],
    ThreadOwnerMismatch: ["the thread belongs to another owner"],
    DuplicateExecutionId: [duplicateExecutionIdMessageOf],
    ContextUnavailable: ["there is no execution to read here"],
    SpendOutsideStep: ["spend was recorded outside a step"],
    ApplicationStopping: ["the application is stopping and takes no new execution"],
    CompensationFailed: [compensationFailedMessageOf],
    OutputInvalid: ["the execution's output is not what its finish declares"],
    NothingToRecover: ["the run stored nothing to continue"],
    RemoteChildLost: ["a remote child run was lost"],
  },
});
