import type { ErrorRecord } from "../error-record.js";
import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import type { KeyTextRule } from "../errors.js";

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
  /** The execution was cancelled and its writes are fenced. */
  export type CancelFenced = ErrorVariant<
    ExecutionErrorKind.CancelFenced,
    "execution.cancelled.fenced"
  >;
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
  >;
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
  >;
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
    CancelFenced: [
      "the execution was cancelled and its writes are fenced",
      "execution.cancelled.fenced",
    ],
    LeaseLost: ["the instance lost the lease of the tree it was moving"],
    Fenced: ["an external system refused a write of this execution", "execution.lease-lost.fenced"],
    ExternallyPaused: ["the execution is paused from outside"],
    AlreadyTerminal: ["the execution already ended"],
    IncompatibleResume: ["the execution cannot be resumed by this version"],
    UnknownThread: ["no such thread"],
    InvalidThreadId: ["the thread id is not a key"],
    InvalidMintedId: ["an id the IdGenerator minted is not a key"],
    ThreadIdsExhausted: ["the IdGenerator minted only ids the tenant already has"],
    ThreadOwnerMismatch: ["the thread belongs to another owner"],
    DuplicateExecutionId: ["the IdGenerator minted an execution id another execution already has"],
    ContextUnavailable: ["there is no execution to read here"],
    SpendOutsideStep: ["spend was recorded outside a step"],
    ApplicationStopping: ["the application is stopping and takes no new execution"],
    CompensationFailed: ["an automatic undo failed"],
    OutputInvalid: ["the execution's output is not what its finish declares"],
    NothingToRecover: ["the run stored nothing to continue"],
    RemoteChildLost: ["a remote child run was lost"],
  },
});

/**
 * The kinds of `ExecutionError` that are a hand-over, not a failure (#265, #471): the instance lost the
 * tree's lease, an external system fenced one of its writes, a cancel fenced them, or the application
 * is stopping. Another instance continues the tree: such an error reaches neither `.onError` nor the
 * record — so a user's `.onError(ExecutionError, …)` never catches it and a stale worker cannot hold on
 * to a lease it lost.
 */
export const HAND_OVER_KINDS: ReadonlySet<ExecutionErrorKind> = new Set([
  ExecutionErrorKind.CancelFenced,
  ExecutionErrorKind.LeaseLost,
  ExecutionErrorKind.Fenced,
  ExecutionErrorKind.ApplicationStopping,
]);

/** The codes of those kinds: what a record's class line names. */
const HAND_OVER_CODES: ReadonlySet<string> = new Set([
  ExecutionError.CancelFenced.code,
  ExecutionError.LeaseLost.code,
  ExecutionError.Fenced.code,
  ExecutionError.ApplicationStopping.code,
]);

/** Whether `error` is an `ExecutionError` of a hand-over kind. */
export const isHandOverError = (error: unknown): error is ExecutionError =>
  error instanceof ExecutionError && HAND_OVER_KINDS.has(error.kind);

/** Whether a record's class line holds a hand-over code: no `.onError` takes it. */
export const isHandOverRecord = (record: ErrorRecord): boolean =>
  record.lineage.some((code) => HAND_OVER_CODES.has(code));
