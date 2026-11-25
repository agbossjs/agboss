import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";
import {
  contractMessageOf,
  deadlineMessageOf,
  meshUnsupportedMessageOf,
  originMessageOf,
  protocolMessageOf,
  remoteCallMessageOf,
  taskCancelledMessageOf,
  taskFailedMessageOf,
  taskInterruptedMessageOf,
  unexpectedFinishMessageOf,
  versionsShownOf,
} from "../../a2a/client/a2a-error-messages.js";
import type {
  A2AClientOperation,
  A2AContractRule,
  A2ARemoteCallReason,
} from "../../a2a/client/a2a-client-errors.js";
import type { A2AOriginSite } from "../../a2a/client/a2a-guard-errors.js";
import type {
  A2ACancelOutcome,
  A2ATaskEnd,
  A2ATaskInterruption,
} from "../../a2a/client/a2a-task-errors.js";

/** The kinds of `A2AError`: `switch (error.kind)` is exhaustive. */
export enum A2AErrorKind {
  CallerRejected = "caller-rejected",
  Contract = "contract",
  Protocol = "protocol",
  Remote = "remote",
  Unavailable = "unavailable",
  Deadline = "deadline",
  TaskCancelled = "task-cancelled",
  TaskFailed = "task-failed",
  TaskInterrupted = "task-interrupted",
  UnexpectedFinish = "unexpected-finish",
  MeshUnsupported = "mesh-unsupported",
  OriginRefused = "origin-refused",
}

/** A call to another agent over A2A failed: the wire, the remote task or the card. */
export type A2AError =
  | A2AError.CallerRejected
  | A2AError.Contract
  | A2AError.Protocol
  | A2AError.Remote
  | A2AError.Unavailable
  | A2AError.Deadline
  | A2AError.TaskCancelled
  | A2AError.TaskFailed
  | A2AError.TaskInterrupted
  | A2AError.UnexpectedFinish
  | A2AError.MeshUnsupported
  | A2AError.OriginRefused;

/** The variants of `A2AError`, each with the facts it carries. */
export declare namespace A2AError {
  /**
   * The A2A server refused the caller (`A2AClient.send` on a `401` / `403` carrying an
   * `a2a.caller-*` code): `httpStatus` and `wireCode` (`a2a.caller-unauthenticated`,
   * `a2a.caller-forbidden`, ...). Nothing ran on the server; its own text is never kept.
   */
  export type CallerRejected = ErrorVariant<A2AErrorKind.CallerRejected, "a2a.caller-rejected"> & {
    /** `401` or `403`. */
    readonly httpStatus: number;
    /** The code the server sent (`{ code, error }`): `a2a.caller-unauthenticated`, ... */
    readonly wireCode: string;
  };
  /**
   * The agent's Agent Card does not serve what the client declares, found before anything is sent:
   * `rule` is the part of the contract it breaks, `differences` the schemas' differences.
   */
  export type Contract = ErrorVariant<A2AErrorKind.Contract, "a2a.contract"> & {
    readonly agent: string;
    readonly rule: A2AContractRule;
    /** The skill, `""` when the rule has none. */
    readonly skill: string;
    readonly differences: readonly string[];
  };
  /**
   * The agent answered an A2A operation with an error, or not as A2A v1.0: its codes only, the
   * agent's own message is never kept.
   */
  export type Protocol = ErrorVariant<A2AErrorKind.Protocol, "a2a.protocol"> & {
    readonly agent: string;
    readonly operation: A2AClientOperation;
    /** The A2A error code the agent answered (`-32602`, …). */
    readonly rpcCode?: number | undefined;
    /** The HTTP status of a response that was no A2A error answer. */
    readonly httpStatus?: number | undefined;
    /** The A2A versions the agent's card declares, when none is one this client speaks. */
    readonly protocolVersions?: readonly string[] | undefined;
  };
  /** The agent answered, but not with what the call needs: no readable output, an unreadable task. */
  export type Remote = ErrorVariant<A2AErrorKind.Remote, "a2a.remote"> & {
    readonly agent: string;
    readonly reason: A2ARemoteCallReason;
    readonly taskId?: string | undefined;
  };
  /** The remote cannot be reached: no answer (a network failure) or the request was never sent. */
  export type Unavailable = ErrorVariant<A2AErrorKind.Unavailable, "a2a.unavailable"> & {
    readonly agent?: string | undefined;
    readonly operation?: A2AClientOperation | undefined;
    /**
     * `false`: the request certainly never left the client. `true` — or not said — the request
     * may have arrived: the outcome is unknown, so only an idempotent send may be repeated.
     */
    readonly sent?: boolean | undefined;
  };
  /** The wait for a remote task reached its deadline; the cancel the client sent is `cancel`. */
  export type Deadline = ErrorVariant<A2AErrorKind.Deadline, "a2a.deadline"> & {
    readonly agent: string;
    readonly taskId: string;
    readonly contextId: string;
    readonly deadlineAt: Date;
    readonly cancel: A2ACancelOutcome;
    /** Whether the agent answered the cancel with a CANCELED task. */
    readonly isCancelled: boolean;
  };
  /** The remote task ended CANCELED. */
  export type TaskCancelled = ErrorVariant<A2AErrorKind.TaskCancelled, "a2a.task-cancelled"> & {
    readonly agent: string;
    readonly taskId: string;
    readonly contextId: string;
  };
  /** The remote task ended FAILED or REJECTED; `remoteCode` is an AGBoss peer's stable code. */
  export type TaskFailed = ErrorVariant<A2AErrorKind.TaskFailed, "a2a.task-failed"> & {
    readonly agent: string;
    readonly taskId: string;
    readonly contextId: string;
    readonly end: A2ATaskEnd;
    readonly remoteCode?: string | undefined;
  };
  /** The remote task waits for its caller: INPUT_REQUIRED or AUTH_REQUIRED. */
  export type TaskInterrupted = ErrorVariant<
    A2AErrorKind.TaskInterrupted,
    "a2a.task-interrupted"
  > & {
    readonly agent: string;
    readonly taskId: string;
    readonly contextId: string;
    readonly interruption: A2ATaskInterruption;
  };
  /** The remote task finished at a finish the typed client does not take (`target.finishes`). */
  export type UnexpectedFinish = ErrorVariant<
    A2AErrorKind.UnexpectedFinish,
    "a2a.unexpected-finish"
  > & {
    readonly agent: string;
    /** The finish the answer named; none when its name is not one a card could list. */
    readonly finish?: string | undefined;
    readonly finishes: readonly string[];
    readonly taskId?: string | undefined;
  };
  /** The agent's card does not declare the AGBoss mesh extension the call requires. */
  export type MeshUnsupported = ErrorVariant<
    A2AErrorKind.MeshUnsupported,
    "a2a.mesh-unsupported"
  > & {
    readonly agent: string;
    readonly application?: string | undefined;
  };
  /** The client would have talked to an origin it was not given: nothing was sent there. */
  export type OriginRefused = ErrorVariant<A2AErrorKind.OriginRefused, "a2a.origin-refused"> & {
    readonly agent: string;
    readonly origin: string;
    readonly site: A2AOriginSite;
    readonly allowedOrigins: readonly string[];
  };
}

/** `A2AError`: the family's constructor and its variants'. */
export const A2AError: FamilyConstructor<
  A2AError,
  {
    CallerRejected: A2AError.CallerRejected;
    Contract: A2AError.Contract;
    Protocol: A2AError.Protocol;
    Remote: A2AError.Remote;
    Unavailable: A2AError.Unavailable;
    Deadline: A2AError.Deadline;
    TaskCancelled: A2AError.TaskCancelled;
    TaskFailed: A2AError.TaskFailed;
    TaskInterrupted: A2AError.TaskInterrupted;
    UnexpectedFinish: A2AError.UnexpectedFinish;
    MeshUnsupported: A2AError.MeshUnsupported;
    OriginRefused: A2AError.OriginRefused;
  }
> = defineFamily({
  name: "A2AError",
  code: "a2a",
  kinds: A2AErrorKind,
  variants: {
    CallerRejected: ["the caller was rejected"],
    // the differences are built from the remote card's names: not for the wire
    Contract: [contractMessageOf, undefined, { hidden: ["differences"] }],
    // a card is remote text: only what reads as a version is kept, in the fact and in the details
    Protocol: [
      protocolMessageOf,
      undefined,
      {
        force: true,
        keep: ({ protocolVersions }: { readonly protocolVersions?: readonly string[] }) =>
          protocolVersions === undefined
            ? {}
            : { protocolVersions: versionsShownOf(protocolVersions) },
      },
    ],
    Remote: [remoteCallMessageOf],
    Unavailable: ["the remote cannot be reached"],
    Deadline: [
      deadlineMessageOf,
      undefined,
      {
        extra: ({ deadlineAt }: { readonly deadlineAt?: Date }) =>
          deadlineAt === undefined ? {} : { deadlineAt: deadlineAt.toISOString() },
      },
    ],
    TaskCancelled: [taskCancelledMessageOf],
    TaskFailed: [taskFailedMessageOf],
    TaskInterrupted: [taskInterruptedMessageOf],
    UnexpectedFinish: [unexpectedFinishMessageOf],
    MeshUnsupported: [meshUnsupportedMessageOf],
    // the allowed origins are local configuration: not for the wire
    OriginRefused: [originMessageOf, undefined, { hidden: ["allowedOrigins"] }],
  },
});
